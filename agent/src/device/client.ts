import { isIP } from "node:net";
import type { MediaAsset } from "../media/animation.js";
import { validateAnimation, validateCover } from "../media/animation.js";
import type { PlaybackPoller } from "../spotify/poller.js";
import type { NowPlayingV1, PlaybackSnapshot } from "../spotify/types.js";
import type { DisplayMode } from "../web/scene.js";

export const MEDIA_STORAGE_RESERVE_BYTES = 32 * 1024;

export class AnimationStorageError extends Error {
  constructor() {
    super("The converted animation does not fit in device storage with space for safe replacement. Choose a GIF with fewer frames; the previously installed GIF is preserved.");
    this.name = "AnimationStorageError";
  }
}

export interface DeviceStatus {
  protocolVersion: "v1";
  firmwareVersion: string;
  ip: string;
  freeStorageBytes: number;
  mode: DisplayMode;
  activeScene: "spotify" | "gif";
}

function validStatus(value: unknown): value is DeviceStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Record<string, unknown>;
  return Object.keys(status).length === 6 && status["protocolVersion"] === "v1" &&
    typeof status["firmwareVersion"] === "string" && status["firmwareVersion"].length > 0 &&
    [...status["firmwareVersion"]].length <= 64 &&
    typeof status["ip"] === "string" && status["ip"].length > 0 &&
    [...status["ip"]].length <= 64 &&
    Number.isSafeInteger(status["freeStorageBytes"]) && Number(status["freeStorageBytes"]) >= 0 &&
    typeof status["mode"] === "string" && ["auto", "spotify", "gif"].includes(status["mode"]) &&
    typeof status["activeScene"] === "string" && ["spotify", "gif"].includes(status["activeScene"]);
}

function isPrivateDeviceAddress(hostname: string): boolean {
  if (hostname === "[::1]") return true;
  if (isIP(hostname) !== 4) return false;
  const [a, b] = hostname.split(".").map(Number);
  return a === 127 || a === 10 || (a === 172 && b !== undefined && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export class DeviceClient {
  private readonly baseUrl: URL;
  private readonly token: string;
  private readonly fetchDevice: typeof fetch;
  private readonly timeoutMs: number;
  private readonly hasTimeoutOverride: boolean;
  private lastPlayback: NowPlayingV1 | null = null;

  constructor(options: { baseUrl: string; token: string; fetchDevice?: typeof fetch; timeoutMs?: number }) {
    this.baseUrl = new URL(options.baseUrl);
    if (this.baseUrl.protocol !== "http:" || this.baseUrl.username || this.baseUrl.password ||
        this.baseUrl.pathname !== "/" || this.baseUrl.search || this.baseUrl.hash || !isPrivateDeviceAddress(this.baseUrl.hostname)) {
      throw new Error("Use a local HTTP origin for the device.");
    }
    if (!options.token || /[\r\n]/.test(options.token)) throw new Error("Provide a valid device pairing token.");
    this.token = options.token;
    this.fetchDevice = options.fetchDevice ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.hasTimeoutOverride = options.timeoutMs !== undefined;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error("Use a positive device timeout.");
  }

  private async request(path: string, method: string, body?: string | Buffer, headers: Record<string, string> = {}, timeoutMs = this.timeoutMs): Promise<Response> {
    try {
      const response = await this.fetchDevice(new URL(path, this.baseUrl), {
        method, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { ...headers, ...(method === "GET" ? {} : { Authorization: `Bearer ${this.token}` }),
          ...(method === "GET" ? {} : { "Content-Length": String(body === undefined ? 0 : Buffer.byteLength(body)) }) },
        ...(body === undefined ? {} : { body }),
      });
      if (response.status !== (method === "GET" ? 200 : 204)) {
        await response.body?.cancel();
        if (path === "/api/v1/animation" && response.status === 413) throw new AnimationStorageError();
        throw new Error("Device request rejected.");
      }
      return response;
    } catch (error) {
      if (error instanceof AnimationStorageError) throw error;
      // Never echo remote bodies, addresses, pairing tokens, or fetch exception details.
      throw new Error("Device communication failed; check pairing, compatibility, and connectivity.");
    }
  }

  async status(): Promise<DeviceStatus> {
    try {
      const response = await this.request("/api/v1/status", "GET");
      const value: unknown = await response.json();
      if (validStatus(value)) return value;
    } catch { /* Report one safe compatibility error. */ }
    throw new Error("The device did not return a compatible protocol v1 status.");
  }

  private async mutate(path: string, method: string, body?: string | Buffer, headers?: Record<string, string>, timeoutMs = this.timeoutMs): Promise<void> {
    await this.status();
    await this.request(path, method, body, headers, timeoutMs);
  }

  private uploadTimeout(bytes: number): number {
    // An explicit timeout overrides every request, including binary uploads.
    return this.hasTimeoutOverride ? this.timeoutMs : 75_000 + Math.ceil(bytes / 8192) * 1000;
  }

  async heartbeat(): Promise<void> { await this.mutate("/api/v1/heartbeat", "POST"); }
  async setMode(mode: DisplayMode): Promise<void> {
    await this.mutate("/api/v1/mode", "PUT", JSON.stringify({ mode }), { "Content-Type": "application/json" });
  }
  async sendPlayback(snapshot: PlaybackSnapshot): Promise<void> {
    // Unavailability is not a confirmed pause. Do not renew stale metadata;
    // firmware expires the last real sample independently of heartbeats.
    if (snapshot.status === "unavailable") return;
    const payload = snapshot.nowPlaying ?? (this.lastPlayback ? {
      ...this.lastPlayback, isPlaying: false, sampledAtUnixMs: snapshot.sampledAtUnixMs,
    } : null);
    if (!payload) return;
    await this.mutate("/api/v1/spotify", "PUT", JSON.stringify(payload), { "Content-Type": "application/json" });
    this.lastPlayback = payload;
  }
  async uploadCover(trackId: string, asset: MediaAsset): Promise<void> {
    validateCover(asset.bytes, asset.sha256);
    await this.mutate("/api/v1/cover", "PUT", asset.bytes, {
      "Content-Type": "application/octet-stream", "X-Content-SHA256": asset.sha256,
      "X-Track-Id": encodeURIComponent(trackId),
    }, this.hasTimeoutOverride ? this.timeoutMs : 15_000);
  }
  async uploadAnimation(asset: MediaAsset): Promise<void> {
    validateAnimation(asset.bytes, asset.sha256);
    const status = await this.status();
    if (asset.bytes.length + MEDIA_STORAGE_RESERVE_BYTES > status.freeStorageBytes) throw new AnimationStorageError();
    await this.request("/api/v1/animation", "PUT", asset.bytes, {
      "Content-Type": "application/octet-stream", "X-Content-SHA256": asset.sha256,
    }, this.uploadTimeout(asset.bytes.length));
  }
}

export class DeviceSynchronizer {
  private pending: Promise<boolean> | null = null;
  private coverKey: string | null = null;
  private coverPreparation: { key: string; trackId: string; pending: boolean; asset: MediaAsset | null } | null = null;

  constructor(private readonly options: {
    client: DeviceClient;
    poller: PlaybackPoller;
    loadCover?: (url: string) => Promise<MediaAsset>;
    onCoverPrepared?: () => void;
  }) {}

  // True means the requested transport operations succeeded. With no local track
  // history, v1 cannot immediately clear unknown playback left by an older agent;
  // the firmware's independent metadata timeout remains authoritative.
  synchronize(): Promise<boolean> {
    if (this.pending) return this.pending;
    this.pending = this.synchronizeOnce().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async synchronizeOnce(): Promise<boolean> {
    const { client, poller } = this.options;
    try {
      this.prepareCover(poller.currentSnapshot);
      await client.status();
      // Read currentSnapshot each cycle: subscribe() intentionally deduplicates progress.
      await this.refreshPlayback();
      const key = this.currentCoverKey(poller.currentSnapshot);
      const prepared = this.coverPreparation;
      if (key && key !== this.coverKey && prepared?.key === key && prepared.asset) {
        try {
          await client.uploadCover(prepared.trackId, prepared.asset);
          this.coverKey = key;
        } catch { this.coverKey = null; }
        // The server is sequential: refresh only after the upload has settled.
        // Successful metadata/heartbeat keep mode/animation work available even
        // when artwork alone was rejected. Failed communication still falls back.
        await this.refreshPlayback();
      }
      return true;
    } catch {
      this.coverKey = null; // A reboot or failed connection requires artwork resynchronization.
      return false;
    }
  }

  private async refreshPlayback(): Promise<void> {
    await this.options.client.sendPlayback(this.options.poller.currentSnapshot);
    await this.options.client.heartbeat();
  }

  private currentCoverKey(snapshot: PlaybackSnapshot): string | null {
    return snapshot.nowPlaying && snapshot.coverUrl
      ? JSON.stringify([snapshot.nowPlaying.trackId, snapshot.coverUrl]) : null;
  }

  private prepareCover(snapshot: PlaybackSnapshot): void {
    const key = this.currentCoverKey(snapshot);
    const { loadCover } = this.options;
    // At most one download/decoder job and one retained candidate. Never issue
    // device requests from this job, including after scheduler suspension.
    if (this.coverPreparation?.pending) return;
    if (!key || !loadCover || !snapshot.nowPlaying || !snapshot.coverUrl) {
      this.coverPreparation = null;
      return;
    }
    if (key === this.coverKey || (this.coverPreparation?.key === key && this.coverPreparation.asset)) return;
    const prepared = { key, trackId: snapshot.nowPlaying.trackId, pending: true, asset: null as MediaAsset | null };
    this.coverPreparation = prepared;
    void Promise.resolve().then(() => loadCover(snapshot.coverUrl!)).then((asset) => {
      if (this.currentCoverKey(this.options.poller.currentSnapshot) === key) prepared.asset = asset;
    }, () => { /* Artwork failure must not mark working metadata/heartbeat transport offline. */ })
      .finally(() => {
        prepared.pending = false;
        if (prepared.asset) this.options.onCoverPrepared?.();
      });
  }
}
