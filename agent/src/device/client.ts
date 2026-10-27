import { isIP } from "node:net";
import type { MediaAsset } from "../media/animation.js";
import { validateAnimation, validateCover } from "../media/animation.js";
import type { PlaybackPoller } from "../spotify/poller.js";
import type { NowPlayingV1, PlaybackSnapshot } from "../spotify/types.js";
import type { DisplayMode } from "../web/scene.js";

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
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error("Use a positive device timeout.");
  }

  private async request(path: string, method: string, body?: string | Buffer, headers: Record<string, string> = {}): Promise<Response> {
    try {
      const response = await this.fetchDevice(new URL(path, this.baseUrl), {
        method, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
        headers: { ...headers, ...(method === "GET" ? {} : { Authorization: `Bearer ${this.token}` }),
          ...(method === "GET" ? {} : { "Content-Length": String(body === undefined ? 0 : Buffer.byteLength(body)) }) },
        ...(body === undefined ? {} : { body }),
      });
      if (response.status !== (method === "GET" ? 200 : 204)) {
        await response.body?.cancel();
        throw new Error("Device request rejected.");
      }
      return response;
    } catch {
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

  private async mutate(path: string, method: string, body?: string | Buffer, headers?: Record<string, string>): Promise<void> {
    await this.status();
    await this.request(path, method, body, headers);
  }

  async heartbeat(): Promise<void> { await this.mutate("/api/v1/heartbeat", "POST"); }
  async setMode(mode: DisplayMode): Promise<void> {
    await this.mutate("/api/v1/mode", "PUT", JSON.stringify({ mode }), { "Content-Type": "application/json" });
  }
  async sendPlayback(snapshot: PlaybackSnapshot): Promise<void> {
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
    });
  }
  async uploadAnimation(asset: MediaAsset): Promise<void> {
    validateAnimation(asset.bytes, asset.sha256);
    await this.mutate("/api/v1/animation", "PUT", asset.bytes, {
      "Content-Type": "application/octet-stream", "X-Content-SHA256": asset.sha256,
    });
  }
}

export class DeviceSynchronizer {
  private pending: Promise<boolean> | null = null;
  private coverKey: string | null = null;

  constructor(private readonly options: {
    client: DeviceClient;
    poller: PlaybackPoller;
    loadCover?: (url: string) => Promise<MediaAsset>;
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
    const { client, poller, loadCover } = this.options;
    try {
      await client.status();
      // Read currentSnapshot each cycle: subscribe() intentionally deduplicates progress.
      const snapshot = poller.currentSnapshot;
      await client.sendPlayback(snapshot);
      await client.heartbeat();
      const trackId = snapshot.nowPlaying?.trackId;
      const key = trackId && snapshot.coverUrl ? JSON.stringify([trackId, snapshot.coverUrl]) : null;
      if (key && key !== this.coverKey && loadCover && snapshot.coverUrl && trackId) {
        try {
          const cover = await loadCover(snapshot.coverUrl);
          await client.uploadCover(trackId, cover);
          this.coverKey = key;
        } catch { return false; }
      }
      return true;
    } catch {
      this.coverKey = null; // A reboot or failed connection requires artwork resynchronization.
      return false;
    }
  }
}
