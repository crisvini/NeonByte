import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { createCoverAsset, type AnimationAsset, type MediaAsset } from "../media/animation.js";
import { downloadSpotifyCover } from "../web/server.js";
import type { DisplayMode } from "../web/scene.js";
import { AnimationRemovalCommunicationError, AnimationRemovalReceiptError, AnimationReplacementCancelledError,
  AnimationStorageError, DeviceClient, DeviceHttpStatusError, DeviceSynchronizer } from "./client.js";
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
export type AnimationTransferState = "none" | "prepared" | "removing" | "uploading" | "validating" | "complete" | "failed" | "cancelled";
export type PreviousAnimationState = "unchanged" | "removed" | "unknown";
export interface DeviceAnimationView {
  state: AnimationTransferState;
  attempts: number;
  previousAnimation: PreviousAnimationState;
  freeStorageBytes: number | null;
  message: string;
}
export interface DeviceView { address: string; enabled: boolean; paired: boolean; connection: DeviceConnectionStatus; animation: DeviceAnimationView }


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
  private animation: MediaAsset | AnimationAsset | null = null;
  private animationState: DeviceAnimationView = { state: "none", attempts: 0, previousAnimation: "unchanged", freeStorageBytes: null, message: "" };
  private animationReplacementController: AbortController | null = null;
  private coverJob: { url: string; promise: Promise<MediaAsset> } | null = null;

  constructor(private readonly options: { store: DeviceConfigStore; poller: PlaybackPoller; intervalMs: number; fetchDevice?: typeof fetch;
    fetchCover?: typeof fetch; recoveryStore?: RecoveryCredentialStore;
    createMaintenanceClient?: (address: string, token: string) => Pick<MaintenanceClient, "info"> }) {}

  get status(): DeviceView {
    return { address: this.config?.address ?? "", enabled: this.config?.enabled ?? false,
      paired: Boolean(this.config?.token), connection: this.scheduler?.status ?? "disabled", animation: { ...this.animationState } };
  }

  setMode(mode: DisplayMode): void { this.desiredMode = mode; }

  setAnimation(asset: MediaAsset | AnimationAsset): void {
    if (["removing", "uploading", "validating"].includes(this.animationState.state)) {
      throw new Error("Finish or cancel the current animation replacement before choosing another GIF.");
    }
    this.animation = asset;
    const previousAnimation = ["failed", "cancelled"].includes(this.animationState.state)
      ? this.animationState.previousAnimation : "unchanged";
    this.animationState = { state: "prepared", attempts: this.animationState.attempts,
      previousAnimation, freeStorageBytes: null, message: "The converted animation is ready for confirmation." };
  }

  replaceAnimation(): void {
    if (!this.animation) throw new Error("Choose and convert a GIF before replacing the device animation.");
    if (!this.config?.enabled || !this.config.token || this.maintenanceHeld || this.closed) {
      throw new Error("Enable the paired device connection before replacing its animation.");
    }
    if (["removing", "uploading", "validating"].includes(this.animationState.state)) {
      throw new Error("An animation replacement is already in progress.");
    }
    const asset = this.animation;
    const controller = new AbortController();
    const previousState = this.animationState;
    const priorRemoval = previousState.previousAnimation;
    this.animationReplacementController = controller;
    this.animationState = { state: "removing", attempts: previousState.attempts + 1,
      previousAnimation: priorRemoval, freeStorageBytes: null, message: "Checking device compatibility before animation removal." };
    void this.serialize(async () => {
      const config = this.config;
      const scheduler = this.scheduler;
      const resumeScheduler = Boolean(scheduler && !this.maintenanceHeld);
      let previousAnimation: PreviousAnimationState = priorRemoval;
      let freeStorageBytes: number | null = null;
      try {
        if (!config?.enabled || this.closed || this.maintenanceHeld) throw new Error("The device connection is unavailable for animation replacement.");
        await scheduler?.suspendAndDrain();
        this.scheduler = null;
        if (controller.signal.aborted) throw new AnimationReplacementCancelledError();
        const client = this.createClient(config);
        const synchronizer = new DeviceSynchronizer({ client, poller: this.options.poller,
          loadCover: (url) => this.loadCover(url) });
        await client.replaceAnimation(asset, {
          signal: controller.signal,
          betweenChunks: async () => { if (!controller.signal.aborted) await synchronizer.serviceUploadControls(); },
          onRemoved: (receipt) => {
            previousAnimation = "removed";
            freeStorageBytes = receipt.freeStorageBytes;
            this.animationState = { state: "uploading", attempts: previousState.attempts + 1,
              previousAnimation, freeStorageBytes, message: "The previous animation was removed. The device confirmed available storage; sending the converted animation." };
          },
          onStage: (stage) => {
            if (stage === "removing") {
              previousAnimation = "unknown";
              this.animationState = { state: "removing", attempts: previousState.attempts + 1,
                previousAnimation, freeStorageBytes, message: "Removing the installed animation to free device storage." };
            } else {
              this.animationState = { state: stage, attempts: previousState.attempts + 1,
                previousAnimation, freeStorageBytes,
                message: stage === "uploading" ? "Sending the converted NBIF v2 animation." : "The device is checking the complete file before playback." };
            }
          },
        });
        this.animationState = { state: "complete", attempts: previousState.attempts + 1,
          previousAnimation: "removed", freeStorageBytes, message: "The device validated and installed the new animation." };
      } catch (error) {
        const cancelled = controller.signal.aborted || error instanceof AnimationReplacementCancelledError;
        let message = cancelled ? "The replacement was cancelled." : "The replacement could not be completed.";
        if (error instanceof AnimationStorageError) message = "The converted animation and required storage reserve do not fit after removal.";
        else if (error instanceof DeviceHttpStatusError || error instanceof AnimationRemovalCommunicationError ||
                 error instanceof AnimationRemovalReceiptError) message = error.message;
        else if (!cancelled && error instanceof Error && /does not support|frame|duration|capabilit|checksum|NBIF/i.test(error.message)) message = error.message;
        if (previousAnimation === "removed") message += " The previous animation was removed and was not preserved; you can send this converted animation again.";
        else if (previousAnimation === "unknown") message += " The previous animation may already be removed. The converted NBIF v2 remains ready; retry safely because removal is idempotent.";
        else message += " The device animation was not removed.";
        this.animationState = { state: cancelled ? "cancelled" : "failed", attempts: previousState.attempts + 1,
          previousAnimation, freeStorageBytes, message };
      } finally {
        if (this.animationReplacementController === controller) this.animationReplacementController = null;
        if (resumeScheduler && !this.closed && !this.maintenanceHeld && this.config?.enabled) this.startScheduler(this.config);
      }
    });
  }

  cancelAnimationReplacement(): boolean {
    if (!this.animationReplacementController) return false;
    this.animationReplacementController.abort();
    return true;
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

  resumeAfterManualReconciliation(): void {
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
      if (this.animation && this.animationState.state !== "complete") {
        this.animationState = { state: "prepared", attempts: this.animationState.attempts,
          previousAnimation: "unchanged", freeStorageBytes: null, message: "The converted animation is ready for confirmation." };
      }
      if (config.enabled && !this.closed && !this.maintenanceHeld) this.startScheduler(config);
    });
  }

  stop(): Promise<void> {
    this.animationReplacementController?.abort();
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
        return true;
      } catch { return false; }
    } });
    this.scheduler = scheduler;
    scheduler.start();
  }
}
