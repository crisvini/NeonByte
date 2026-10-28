import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { createCoverAsset, type MediaAsset } from "../media/animation.js";
import { downloadSpotifyCover } from "../web/server.js";
import type { DisplayMode } from "../web/scene.js";
import { AnimationStorageError, DeviceClient, DeviceSynchronizer, MEDIA_STORAGE_RESERVE_BYTES } from "./client.js";
import { DeviceScheduler, type DeviceConnectionStatus } from "./scheduler.js";
import type { PlaybackPoller } from "../spotify/poller.js";
import { MaintenanceClient } from "./maintenance-client.js";
import type { RecoveryCredential, RecoveryCredentialStore } from "./recovery-store.js";

export interface DeviceConfig { address: string; token: string; enabled: boolean }
export interface DeviceConfigStore {
  get(): Promise<DeviceConfig | null>;
  set(config: DeviceConfig): Promise<void>;
}
export interface DeviceSettings { address: string; token?: string; enabled: boolean }
export interface DeviceView { address: string; enabled: boolean; paired: boolean; connection: DeviceConnectionStatus;
  animation: { state: "none" | "queued" | "uploading" | "retrying" | "blocked" | "complete"; attempts: number } }


/** The address and pairing token share one credential-manager entry. */
export class SystemDeviceConfigStore implements DeviceConfigStore {
  private async entry() {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    const Entry = AsyncEntry as unknown as new (service: string, account: string, options: { linux: { store: "secret-service" } }) => {
      getPassword(): Promise<string | null | undefined>; setPassword(value: string): Promise<void>;
    };
    return new Entry("NeonByte", "device-configuration", { linux: { store: "secret-service" } });
  }
  async get(): Promise<DeviceConfig | null> {
    try {
      const value = await (await this.entry()).getPassword();
      if (!value) return null;
      const config: unknown = JSON.parse(value);
      if (!config || typeof config !== "object") throw new Error();
      const item = config as Record<string, unknown>;
      if (typeof item["address"] !== "string" || typeof item["token"] !== "string" || typeof item["enabled"] !== "boolean") throw new Error();
      return { address: item["address"], token: item["token"], enabled: item["enabled"] };
    } catch { throw new Error("Unable to read device configuration from the system credential manager."); }
  }
  async set(config: DeviceConfig): Promise<void> {
    try { await (await this.entry()).setPassword(JSON.stringify(config)); }
    catch { throw new Error("Unable to save device configuration in the system credential manager."); }
  }
}

export class DeviceIntegration {
  private config: DeviceConfig | null = null;
  private scheduler: DeviceScheduler | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private maintenanceHeld = false;
  private desiredMode: DisplayMode | null = null;
  private animation: MediaAsset | null = null;
  private animationState: DeviceView["animation"] = { state: "none", attempts: 0 };
  private animationSent: string | null = null;
  private coverJob: { url: string; promise: Promise<MediaAsset> } | null = null;

  constructor(private readonly options: { store: DeviceConfigStore; poller: PlaybackPoller; intervalMs: number; fetchDevice?: typeof fetch;
    fetchCover?: typeof fetch; recoveryStore?: RecoveryCredentialStore;
    createMaintenanceClient?: (address: string, token: string) => Pick<MaintenanceClient, "info"> }) {}

  get status(): DeviceView {
    return { address: this.config?.address ?? "", enabled: this.config?.enabled ?? false,
      paired: Boolean(this.config?.token), connection: this.scheduler?.status ?? "disabled", animation: { ...this.animationState } };
  }

  setMode(mode: DisplayMode): void { this.desiredMode = mode; }

  setAnimation(asset: MediaAsset): void {
    if (this.animation?.sha256 === asset.sha256) return;
    this.animation = asset;
    this.animationSent = null;
    this.animationState = { state: "queued", attempts: 0 };
  }

  private async loadCover(url: string): Promise<MediaAsset> {
    // Scheduler replacement must not multiply downloads/decoders. Reuse the
    // same URL, or wait for the bounded prior job before preparing another.
    while (this.coverJob) {
      const previous = this.coverJob;
      if (previous.url === url) return previous.promise;
      try { await previous.promise; } catch { /* A different cover may still succeed. */ }
    }
    const job = { url, promise: this.decodeCover(url) };
    this.coverJob = job;
    try { return await job.promise; }
    finally { if (this.coverJob === job) this.coverJob = null; }
  }

  private async decodeCover(url: string): Promise<MediaAsset> {
    const bytes = url === "/demo-cover.svg"
      ? await readFile(new URL("../web/public/demo-cover.svg", import.meta.url))
      : (await downloadSpotifyCover(url, this.options.fetchCover ?? fetch)).bytes;
    const decoded = await sharp(bytes, { limitInputPixels: 16_000_000 }).timeout({ seconds: 10 })
      .resize(240, 240, { fit: "cover" }).ensureAlpha().raw().toBuffer();
    return createCoverAsset(decoded, 240, 240);
  }

  private serialize(action: () => Promise<void>): Promise<void> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  start(): Promise<void> {
    return this.serialize(async () => {
      if (this.closed) return;
      const config = await this.options.store.get();
      if (!config) return;
      let effective = config;
      if (this.options.recoveryStore) {
        let recovery: RecoveryCredential | null = null;
        try { recovery = await this.options.recoveryStore.get(); } catch { /* Preserve the legacy device entry when maintenance storage is unavailable. */ }
        if (recovery) {
          try {
            const maintenance = (this.options.createMaintenanceClient ?? ((address, token) => new MaintenanceClient({ baseUrl: address, token })))(
              recovery.lastVerifiedAddress, recovery.token);
            const info = await maintenance.info();
            if (info.deviceId === recovery.deviceId && info.profile === recovery.profile && info.recoveryIdentityFingerprint === recovery.recoveryIdentityFingerprint) {
              effective = { ...config, address: recovery.lastVerifiedAddress };
            }
          } catch { /* A stale maintenance address never replaces the legacy application address. */ }
        }
      }
      this.createClient(effective);
      this.config = effective;
      if (effective.enabled && !this.closed && !this.maintenanceHeld) this.startScheduler(effective);
    });
  }

  suspendAndDrain(): Promise<void> {
    return this.serialize(async () => {
      this.maintenanceHeld = true;
      await this.scheduler?.suspendAndDrain();
      this.scheduler = null;
    });
  }

  holdForMaintenance(): void { this.maintenanceHeld = true; }

  async rebindVerifiedAddress(address: string, resumeScheduler = false): Promise<void> {
    await this.serialize(async () => {
      if (this.closed) throw new Error("The device integration is stopping.");
      await this.scheduler?.suspendAndDrain();
      this.scheduler = null;
      if (!this.config) return;
      const config = { ...this.config, address };
      this.createClient(config);
      this.config = config;
      this.maintenanceHeld = !resumeScheduler;
      if (resumeScheduler && config.enabled) this.startScheduler(config);
    });
  }

  resumeAfterExplicitRun(): void {
    this.releaseMaintenanceHold();
  }

  resumeAfterSafePreflightAbort(): void {
    this.releaseMaintenanceHold();
  }

  private releaseMaintenanceHold(): void {
    this.maintenanceHeld = false;
    if (!this.closed && this.config?.enabled && !this.scheduler) this.startScheduler(this.config);
  }

  configure(settings: DeviceSettings): Promise<void> {
    return this.serialize(async () => {
      if (this.closed) throw new Error("The device integration is stopping.");
      if (typeof settings.address !== "string" || typeof settings.enabled !== "boolean" ||
          (settings.token !== undefined && typeof settings.token !== "string")) throw new Error("Invalid device configuration.");
      const address = settings.address.trim();
      const previous = this.config;
      const token = settings.token || (previous?.address === address ? previous.token : "");
      if (!token) throw new Error("Provide the device pairing token for this address.");
      const config = { address, token, enabled: settings.enabled };
      this.createClient(config);
      await this.scheduler?.stop();
      this.scheduler = null;
      try { await this.options.store.set(config); }
      catch { this.config = previous ? { ...previous, enabled: false } : null; throw new Error("Unable to save device configuration in the system credential manager."); }
      this.config = config;
      this.animationSent = null;
      if (this.animation) this.animationState = { state: "queued", attempts: 0 };
      if (config.enabled && !this.closed && !this.maintenanceHeld) this.startScheduler(config);
    });
  }

  stop(): Promise<void> {
    this.closed = true;
    return this.serialize(async () => { await this.scheduler?.stop(); this.scheduler = null; });
  }

  private createClient(config: DeviceConfig): DeviceClient {
    try { return new DeviceClient({ baseUrl: config.address, token: config.token, ...(this.options.fetchDevice ? { fetchDevice: this.options.fetchDevice } : {}) }); }
    catch { throw new Error("Provide a valid device HTTP address and pairing token."); }
  }

  private startScheduler(config: DeviceConfig): void {
    const client = this.createClient(config);
    const synchronizer = new DeviceSynchronizer({ client, poller: this.options.poller, loadCover: (url) => this.loadCover(url),
      onCoverPrepared: () => scheduler.requestSynchronization() });
    const scheduler = new DeviceScheduler({ intervalMs: this.options.intervalMs, synchronize: async () => {
      if (!await synchronizer.synchronize()) return false;
      try {
        const status = await client.status();
        const mode = this.desiredMode;
        if (mode && status.mode !== mode) await client.setMode(mode);
        const animation = this.animation;
        if (animation && animation.sha256 !== this.animationSent) {
          if (animation.bytes.length + MEDIA_STORAGE_RESERVE_BYTES > status.freeStorageBytes) {
            this.animationState = { state: "blocked", attempts: this.animationState.attempts };
            return true; // Keep playback and heartbeat synchronization alive while storage is full.
          }
          this.animationState = { state: "uploading", attempts: this.animationState.attempts + 1 };
          try {
            await client.uploadAnimation(animation);
            if (this.animation === animation) {
              this.animationSent = animation.sha256;
              this.animationState = { state: "complete", attempts: this.animationState.attempts };
            }
          } catch (error) {
            const storageFull = error instanceof AnimationStorageError;
            if (this.animation === animation) this.animationState = { state: storageFull ? "blocked" : "retrying", attempts: this.animationState.attempts };
            return storageFull;
          }
        }
        return true;
      } catch { return false; }
    } });
    this.scheduler = scheduler;
    scheduler.start();
  }
}
