export type DeviceConnectionStatus = "disabled" | "connecting" | "connected" | "disconnected";

/** Runs one synchronization at a time. No work starts until explicitly enabled. */
export class DeviceScheduler {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private pending: Promise<void> | null = null;
  private state: DeviceConnectionStatus = "disabled";

  constructor(private readonly options: { intervalMs: number; synchronize(): Promise<boolean> }) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
      throw new RangeError("The synchronization interval must be a positive integer.");
    }
  }

  get status(): DeviceConnectionStatus { return this.state; }

  start(): void {
    if (this.running || this.pending) return;
    this.running = true;
    this.state = "connecting";
    this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.pending;
    this.state = "disabled";
  }

  private run(): void {
    this.pending = (async () => {
      let success = false;
      try { success = await this.options.synchronize(); } catch { /* Retry without exposing remote errors. */ }
      if (this.running) this.state = success ? "connected" : "disconnected";
    })().finally(() => {
      this.pending = null;
      if (this.running) this.timer = setTimeout(() => { this.timer = null; this.run(); }, this.options.intervalMs);
    });
  }
}
