import { DeviceClient, DeviceSynchronizer } from "./client.js";
import { DeviceScheduler, type DeviceConnectionStatus } from "./scheduler.js";
import type { PlaybackPoller } from "../spotify/poller.js";

export interface DeviceConfig { address: string; token: string; enabled: boolean }
export interface DeviceConfigStore {
  get(): Promise<DeviceConfig | null>;
  set(config: DeviceConfig): Promise<void>;
}
export interface DeviceSettings { address: string; token?: string; enabled: boolean }
export interface DeviceView { address: string; enabled: boolean; paired: boolean; connection: DeviceConnectionStatus }

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

  constructor(private readonly options: { store: DeviceConfigStore; poller: PlaybackPoller; intervalMs: number; fetchDevice?: typeof fetch }) {}

  get status(): DeviceView {
    return { address: this.config?.address ?? "", enabled: this.config?.enabled ?? false,
      paired: Boolean(this.config?.token), connection: this.scheduler?.status ?? "disabled" };
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
      this.createClient(config);
      this.config = config;
      if (config.enabled && !this.closed) this.startScheduler(config);
    });
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
      if (config.enabled && !this.closed) this.startScheduler(config);
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
    const synchronizer = new DeviceSynchronizer({ client: this.createClient(config), poller: this.options.poller });
    this.scheduler = new DeviceScheduler({ intervalMs: this.options.intervalMs, synchronize: () => synchronizer.synchronize() });
    this.scheduler.start();
  }
}
