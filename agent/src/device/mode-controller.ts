import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DisplayMode } from "../web/scene.js";

interface PendingModeCommand {
  mode: DisplayMode;
  targetFingerprint: string;
  revision: number;
}

export interface StoredModeState {
  version: 1;
  mode: DisplayMode;
  revision: number;
  pendingCommand: PendingModeCommand | null;
}

export type ModeSyncState = "local" | "pending" | "confirmed" | "failed";

export interface DisplayModeView {
  mode: DisplayMode;
  confirmedMode: DisplayMode | null;
  pendingMode: DisplayMode | null;
  syncState: ModeSyncState;
  message: string;
  observedAtUnixMs: number | null;
}

export interface DisplayModeStore {
  load(): Promise<StoredModeState | null>;
  save(state: StoredModeState): Promise<void>;
}

function isDisplayMode(value: unknown): value is DisplayMode {
  return value === "auto" || value === "spotify" || value === "gif";
}

function validStoredState(value: unknown): value is StoredModeState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item["version"] !== 1 || !isDisplayMode(item["mode"]) ||
      !Number.isSafeInteger(item["revision"]) || (item["revision"] as number) < 0) return false;
  if (item["pendingCommand"] === null) return true;
  const pending = item["pendingCommand"];
  if (typeof pending !== "object" || pending === null || Array.isArray(pending)) return false;
  const command = pending as Record<string, unknown>;
  return isDisplayMode(command["mode"]) && typeof command["targetFingerprint"] === "string" &&
    /^[a-f0-9]{64}$/.test(command["targetFingerprint"]) &&
    Number.isSafeInteger(command["revision"]) && (command["revision"] as number) > 0;
}

function defaultModeStatePath(): string {
  if (process.platform === "win32") {
    const localAppData = process.env["LOCALAPPDATA"];
    if (!localAppData) throw new Error("Local display mode settings are unavailable for this user.");
    return join(localAppData, "NeonByte", "display-mode.json");
  }
  const dataHome = process.env["XDG_DATA_HOME"] || join(process.env["HOME"] || ".", ".local", "share");
  return join(dataHome, "NeonByte", "display-mode.json");
}

export class FileDisplayModeStore implements DisplayModeStore {
  private readonly path: string;

  constructor(path = defaultModeStatePath()) {
    this.path = resolve(path);
  }

  async load(): Promise<StoredModeState | null> {
    let info;
    try { info = await lstat(this.path); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw new Error("Local display mode settings could not be read.");
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) {
      throw new Error("Local display mode settings are invalid.");
    }
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!validStoredState(value)) throw new Error();
      return value;
    } catch {
      throw new Error("Local display mode settings are invalid.");
    }
  }

  async save(state: StoredModeState): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(directory, `.display-mode-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(JSON.stringify(state), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.path);
    } catch {
      throw new Error("Local display mode settings could not be saved.");
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

export function modeTargetId(pairingToken: string): string {
  return createHash("sha256").update(pairingToken).digest("hex");
}

export class DisplayModeController {
  private state: StoredModeState;
  private ready = false;
  private persistenceError = "";
  private confirmedMode: DisplayMode | null = null;
  private observedAtUnixMs: number | null = null;
  private syncState: ModeSyncState = "local";
  private message = "This selection is saved for the local preview.";
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly store: DisplayModeStore, private readonly defaultMode: DisplayMode) {
    this.state = { version: 1, mode: defaultMode, revision: 0, pendingCommand: null };
  }

  get selectedMode(): DisplayMode { return this.state.mode; }

  get view(): DisplayModeView {
    return { mode: this.state.mode, confirmedMode: this.confirmedMode,
      pendingMode: this.state.pendingCommand?.mode ?? null, syncState: this.syncState,
      message: this.message, observedAtUnixMs: this.observedAtUnixMs };
  }

  async initialize(): Promise<void> {
    if (this.ready) return;
    try {
      const loaded = await this.store.load();
      if (loaded) this.state = loaded;
      if (this.state.pendingCommand) {
        this.syncState = "pending";
        this.message = "A manually selected mode is waiting for device confirmation.";
      } else {
        this.syncState = "local";
        this.message = "This selection is saved for the local preview.";
      }
    } catch (error) {
      this.persistenceError = error instanceof Error ? error.message : "Local display mode settings are unavailable.";
      this.syncState = "failed";
      this.message = `${this.persistenceError} Mode changes are unavailable until the settings can be saved.`;
    }
    this.ready = true;
  }

  async selectManual(mode: DisplayMode, targetFingerprint: string | null): Promise<void> {
    await this.serialize(async () => {
      if (!this.ready) await this.initialize();
      if (!isDisplayMode(mode)) throw new Error("Select Auto, Spotify, or GIF mode.");
      if (this.persistenceError) throw new Error(this.persistenceError);
      if (mode === this.state.mode && !this.state.pendingCommand) return;
      const revision = this.state.revision + 1;
      const next: StoredModeState = { version: 1, mode, revision,
        pendingCommand: targetFingerprint ? { mode, targetFingerprint, revision } : null };
      try { await this.store.save(next); }
      catch (error) {
        this.persistenceError = error instanceof Error ? error.message : "Local display mode settings could not be saved.";
        this.syncState = "failed";
        this.message = `${this.persistenceError} The previous selection remains active.`;
        throw new Error(this.message);
      }
      this.state = next;
      this.syncState = targetFingerprint ? "pending" : "local";
      this.message = targetFingerprint
        ? "Waiting for the paired device to confirm your manual selection."
        : "Saved for the local preview; no paired device was configured when you selected it.";
    });
  }

  async pendingCommandFor(targetFingerprint: string | null): Promise<Readonly<PendingModeCommand> | null> {
    let result: Readonly<PendingModeCommand> | null = null;
    await this.serialize(async () => {
      const pending = this.state.pendingCommand;
      if (!pending) return;
      if (pending.targetFingerprint === targetFingerprint) {
        result = { ...pending };
        return;
      }
      const next: StoredModeState = { ...this.state, pendingCommand: null };
      try { await this.store.save(next); }
      catch (error) {
        this.syncState = "failed";
        this.message = error instanceof Error ? error.message : "The previous paired device could not be confirmed.";
        return;
      }
      this.state = next;
      this.syncState = "failed";
      this.message = "Pairing credentials changed. Select a mode again for this device.";
    });
    return result;
  }

  async observeDeviceMode(mode: DisplayMode, targetFingerprint: string, observedAtUnixMs = Date.now()): Promise<void> {
    await this.serialize(async () => {
      if (!isDisplayMode(mode)) return;
      this.confirmedMode = mode;
      this.observedAtUnixMs = observedAtUnixMs;
      const pending = this.state.pendingCommand;
      if (!pending) {
        if (this.syncState === "failed") return;
        this.syncState = mode === this.state.mode ? "confirmed" : "local";
        this.message = mode === this.state.mode
          ? "The device reports the saved mode."
          : "The device is in a different mode. Select another mode to change the display.";
        return;
      }
      if (pending.targetFingerprint !== targetFingerprint || pending.mode !== mode) return;
      const next: StoredModeState = { ...this.state, pendingCommand: null };
      try { await this.store.save(next); }
      catch (error) {
        this.syncState = "failed";
        this.message = error instanceof Error ? error.message : "The device confirmed the mode but the local state could not be saved.";
        return;
      }
      this.state = next;
      this.syncState = "confirmed";
      this.message = "The device confirmed the manually selected mode.";
    });
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
