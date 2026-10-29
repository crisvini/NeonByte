import { isIP } from "node:net";
import { createHash } from "node:crypto";
import type { AnimationAsset, MediaAsset } from "../media/animation.js";
import { ANIMATION_HEADER_BYTES, COVER_BYTES, DISPLAY_HEIGHT, DISPLAY_WIDTH, MEDIA_VERSION, validateAnimation, validateCover } from "../media/animation.js";
import { decodeAnimationV2, validateAnimationV2 } from "../media/animation-decoder.js";
import type { PlaybackPoller } from "../spotify/poller.js";
import type { NowPlayingV1, PlaybackSnapshot } from "../spotify/types.js";
import type { DisplayMode } from "../web/scene.js";

export const MEDIA_STORAGE_RESERVE_BYTES = 32 * 1024;
const ANIMATION_CHUNK_BYTES = 1024;

export class DeviceHttpStatusError extends Error {
  constructor(readonly status: number, readonly firmwareCode?: string, readonly firmwareMessage?: string) {
    const detail = firmwareCode ? `, firmware code ${firmwareCode}` : "";
    super(firmwareMessage
      ? `The device rejected the request (HTTP ${status}${detail}): ${firmwareMessage}`
      : `The device rejected the request (HTTP ${status}${detail}).`);
    this.name = "DeviceHttpStatusError";
  }
}

export class AnimationRemovalCommunicationError extends Error {
  constructor() {
    super("The ESP8266 connection ended before the authenticated animation-removal response arrived. The old animation may already be removed; retry with the prepared NBIF v2. Repeating DELETE is safe.");
    this.name = "AnimationRemovalCommunicationError";
  }
}

export class AnimationRemovalReceiptError extends Error {
  constructor(status: number, reason: string) {
    super(`The ESP8266 returned HTTP ${status}, but ${reason}. The old animation may already be removed; retry with the prepared NBIF v2. Repeating DELETE is safe.`);
    this.name = "AnimationRemovalReceiptError";
  }
}

export class AnimationStorageError extends Error {
  constructor() {
    super("The converted animation does not fit in device storage with the required reserve. Choose a GIF with fewer frames.");
    this.name = "AnimationStorageError";
  }
}

export class AnimationReplacementCancelledError extends Error {
  constructor() { super("The animation replacement was cancelled."); this.name = "AnimationReplacementCancelledError"; }
}

export interface AnimationRemovalReceipt {
  removed: true;
  freeStorageBytes: number;
}

export type AnimationUploadStage = "uploading" | "validating";

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

interface MediaCapabilities {
  width: number;
  height: number;
  maxFrames: number;
  maxDurationMs: number;
  formats: string[];
  maxEncodedBytes: number;
  maxChunkBytes: number;
  reserveBytes: number;
  freeStorageBytes: number;
}

function validMediaCapabilities(value: unknown): value is MediaCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const capabilities = value as Record<string, unknown>;
  return Object.keys(capabilities).length === 9 &&
    Array.isArray(capabilities["formats"]) && capabilities["formats"].length === 2 &&
    capabilities["formats"][0] === "nbif-v1" && capabilities["formats"][1] === "nbif-v2" &&
    capabilities["width"] === 240 && capabilities["height"] === 240 &&
    Number.isSafeInteger(capabilities["maxFrames"]) && Number(capabilities["maxFrames"]) >= 1 && Number(capabilities["maxFrames"]) <= 60 &&
    Number.isSafeInteger(capabilities["maxDurationMs"]) && Number(capabilities["maxDurationMs"]) >= 1 && Number(capabilities["maxDurationMs"]) <= 30_000 &&
    Number.isSafeInteger(capabilities["maxEncodedBytes"]) && Number(capabilities["maxEncodedBytes"]) > 0 &&
    Number.isSafeInteger(capabilities["maxChunkBytes"]) && Number(capabilities["maxChunkBytes"]) >= 1 && Number(capabilities["maxChunkBytes"]) <= 1024 &&
    Number.isSafeInteger(capabilities["reserveBytes"]) && Number(capabilities["reserveBytes"]) >= MEDIA_STORAGE_RESERVE_BYTES &&
    Number.isSafeInteger(capabilities["freeStorageBytes"]) && Number(capabilities["freeStorageBytes"]) >= 0;
}

function validAnimationRemovalReceipt(value: unknown): value is AnimationRemovalReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return Object.keys(receipt).length === 2 && receipt["removed"] === true &&
    Number.isSafeInteger(receipt["freeStorageBytes"]) && Number(receipt["freeStorageBytes"]) >= 0;
}

function createLegacyFallback(asset: AnimationAsset): MediaAsset {
  if (asset.frameCount > 20) throw new Error(`This device supports at most 20 animation frames; this animation has ${asset.frameCount}.`);
  const decoded = decodeAnimationV2(asset.bytes);
  const bytes = Buffer.alloc(ANIMATION_HEADER_BYTES + decoded.frames.length * (2 + COVER_BYTES));
  bytes.write("NBIF", 0, "ascii");
  bytes[4] = MEDIA_VERSION;
  bytes.writeUInt16LE(DISPLAY_WIDTH, 5);
  bytes.writeUInt16LE(DISPLAY_HEIGHT, 7);
  bytes.writeUInt16LE(decoded.frames.length, 9);
  let offset = ANIMATION_HEADER_BYTES;
  decoded.frames.forEach((frame, index) => {
    bytes.writeUInt16LE(decoded.delaysMs[index]!, offset);
    offset += 2;
    frame.copy(bytes, offset);
    offset += frame.length;
  });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  validateAnimation(bytes, sha256);
  return { bytes, sha256 };
}

interface AnimationUploadStatus {
  uploadId: string;
  state: "receiving" | "verifying" | "ready" | "installed" | "failed" | "cancelled";
  nextOffset: number;
  expectedBytes: number;
  receivedBytes: number;
  error: string;
}

function validAnimationUploadStatus(value: unknown, uploadId: string): value is AnimationUploadStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  return Object.keys(status).length === 6 && status["uploadId"] === uploadId &&
    typeof status["state"] === "string" && ["receiving", "verifying", "ready", "installed", "failed", "cancelled"].includes(status["state"]) &&
    Number.isSafeInteger(status["nextOffset"]) && Number(status["nextOffset"]) >= 0 &&
    Number.isSafeInteger(status["expectedBytes"]) && Number(status["expectedBytes"]) >= 1 &&
    Number.isSafeInteger(status["receivedBytes"]) && Number(status["receivedBytes"]) >= 0 &&
    typeof status["error"] === "string";
}

function safeResponseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

const SAFE_FIRMWARE_ERROR_MESSAGES = new Set([
  "A valid bearer token is required.",
  "The application is paused; use authenticated maintenance.",
  "The active animation transfer could not be cancelled.",
  "The installed animation could not be removed.",
  "Available animation storage is unavailable.",
  "The animation upload request does not match the supported route.",
]);

async function safeFirmwareError(response: Response): Promise<{ code: string; message?: string } | null> {
  let value: unknown;
  try { value = await response.json(); }
  catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (Object.keys(receipt).length !== 2 || typeof receipt["code"] !== "string" ||
      !/^[a-z][a-z0-9_]{0,47}$/.test(receipt["code"])) return null;
  const message = typeof receipt["message"] === "string" && SAFE_FIRMWARE_ERROR_MESSAGES.has(receipt["message"])
    ? receipt["message"] : undefined;
  return { code: receipt["code"], ...(message ? { message } : {}) };
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

  private async request(path: string, method: string, body?: string | Buffer, headers: Record<string, string> = {},
                        timeoutMs = this.timeoutMs, acceptedStatuses?: readonly number[], preserveStatusError = false,
                        signal?: AbortSignal): Promise<Response> {
    try {
      const publicStatus = method === "GET" && path === "/api/v1/status";
      const response = await this.fetchDevice(new URL(path, this.baseUrl), {
        method, redirect: "error", signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
        headers: { ...headers, ...(publicStatus ? {} : { Authorization: `Bearer ${this.token}` }),
          ...(method === "GET" ? {} : { "Content-Length": String(body === undefined ? 0 : Buffer.byteLength(body)) }) },
        ...(body === undefined ? {} : { body }),
      });
      const expected = acceptedStatuses ?? [method === "GET" ? 200 : 204];
      if (!expected.includes(response.status)) {
        if (path === "/api/v1/animation" && response.status === 413) throw new AnimationStorageError();
        if (preserveStatusError) {
          const firmwareError = await safeFirmwareError(response);
          throw new DeviceHttpStatusError(response.status, firmwareError?.code, firmwareError?.message);
        }
        await response.body?.cancel();
        throw new DeviceHttpStatusError(response.status);
      }
      return response;
    } catch (error) {
      if (signal?.aborted) throw new AnimationReplacementCancelledError();
      if (error instanceof AnimationStorageError || (preserveStatusError && error instanceof DeviceHttpStatusError)) throw error;
      if (path === "/api/v2/animation" && method === "DELETE") throw new AnimationRemovalCommunicationError();
      // Never echo remote bodies, addresses, pairing tokens, or fetch exception details.
      throw new Error("Device communication failed; check pairing, compatibility, and connectivity.");
    }
  }

  async status(signal?: AbortSignal): Promise<DeviceStatus> {
    try {
      const response = await this.request("/api/v1/status", "GET", undefined, {}, this.timeoutMs, undefined, false, signal);
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
  async serviceUploadControls(snapshot: PlaybackSnapshot): Promise<void> {
    // The upload session has already authenticated this client. Avoid an
    // extra status round trip for every 1 KiB chunk while keeping Spotify
    // freshness and heartbeat timers alive.
    if (snapshot.status !== "unavailable") {
      const payload = snapshot.nowPlaying ?? (this.lastPlayback ? {
        ...this.lastPlayback, isPlaying: false, sampledAtUnixMs: snapshot.sampledAtUnixMs,
      } : null);
      if (payload) {
        try {
          await this.request("/api/v1/spotify", "PUT", JSON.stringify(payload), { "Content-Type": "application/json" });
          this.lastPlayback = payload;
        } catch { /* A heartbeat still keeps upload and device presence alive. */ }
      }
    }
    await this.request("/api/v1/heartbeat", "POST");
  }
  async uploadCover(trackId: string, asset: MediaAsset): Promise<void> {
    validateCover(asset.bytes, asset.sha256);
    await this.mutate("/api/v1/cover", "PUT", asset.bytes, {
      "Content-Type": "application/octet-stream", "X-Content-SHA256": asset.sha256,
      "X-Track-Id": encodeURIComponent(trackId),
    }, this.hasTimeoutOverride ? this.timeoutMs : 15_000);
  }
  private async uploadLegacyAnimation(asset: MediaAsset, freeStorageBytes: number): Promise<void> {
    validateAnimation(asset.bytes, asset.sha256);
    if (asset.bytes.length + MEDIA_STORAGE_RESERVE_BYTES > freeStorageBytes) throw new AnimationStorageError();
    await this.request("/api/v1/animation", "PUT", asset.bytes, {
      "Content-Type": "application/octet-stream", "X-Content-SHA256": asset.sha256,
    }, this.uploadTimeout(asset.bytes.length));
  }

  private async animationUploadStatus(uploadId: string, signal?: AbortSignal): Promise<AnimationUploadStatus> {
    const response = await this.request(`/api/v2/animation/uploads/${uploadId}`, "GET", undefined, {}, this.timeoutMs, undefined, false, signal);
    const value = await safeResponseJson(response);
    if (!validAnimationUploadStatus(value, uploadId)) throw new Error("The device returned an invalid animation upload status.");
    return value;
  }

  async uploadAnimation(asset: MediaAsset | AnimationAsset, betweenChunks: () => Promise<void> = async () => {}): Promise<void> {
    return this.uploadAnimationWithOptions(asset, betweenChunks);
  }

  async replaceAnimation(asset: MediaAsset | AnimationAsset, options: {
    betweenChunks?: () => Promise<void>;
    signal?: AbortSignal;
    onRemoved?: (receipt: AnimationRemovalReceipt) => void;
    onStage?: (stage: "removing" | AnimationUploadStage) => void;
  } = {}): Promise<AnimationRemovalReceipt> {
    if (asset.bytes[4] !== 2) throw new Error("Only a locally validated NBIF v2 animation can replace the installed animation.");
    validateAnimationV2(asset.bytes, asset.sha256);
    await this.status(options.signal);
    let capabilities: MediaCapabilities | null;
    try { capabilities = await this.animationCapabilities(options.signal, false); }
    catch (error) {
      if (error instanceof DeviceHttpStatusError && error.status === 404) {
        throw new Error("This device firmware does not support the authenticated NBIF v2 replacement workflow.");
      }
      throw error;
    }
    if (!capabilities) throw new Error("This device firmware does not support the authenticated NBIF v2 replacement workflow.");
    this.validateAnimationCapacity(asset as AnimationAsset, capabilities);

    options.onStage?.("removing");
    const response = await this.request("/api/v2/animation", "DELETE", undefined, {}, this.timeoutMs, [200], true, options.signal);
    let value: unknown;
    let body: string;
    try { body = await response.text(); }
    catch { throw new AnimationRemovalReceiptError(response.status, "the connection closed before its JSON receipt was complete"); }
    try { value = JSON.parse(body) as unknown; }
    catch { throw new AnimationRemovalReceiptError(response.status, "its removal receipt was not valid JSON"); }
    if (!validAnimationRemovalReceipt(value)) {
      throw new AnimationRemovalReceiptError(response.status, "its JSON receipt did not confirm removal and report available storage");
    }
    options.onRemoved?.(value);
    if (value.freeStorageBytes < asset.bytes.length + capabilities.reserveBytes) throw new AnimationStorageError();
    if (options.signal?.aborted) throw new AnimationReplacementCancelledError();
    await this.uploadAnimationWithOptions(asset, options.betweenChunks ?? (async () => {}), options.signal,
      options.onStage);
    return value;
  }

  private async animationCapabilities(signal?: AbortSignal, allowMissing = true): Promise<MediaCapabilities | null> {
    let response: Response;
    try {
      response = await this.request("/api/v2/media-capabilities", "GET", undefined, {}, this.timeoutMs, [200], true, signal);
    } catch (error) {
      if (allowMissing && error instanceof DeviceHttpStatusError && error.status === 404) return null;
      throw error;
    }
    const value = await safeResponseJson(response);
    if (!validMediaCapabilities(value)) throw new Error("The device returned invalid media capabilities.");
    return value;
  }

  private validateAnimationCapacity(asset: AnimationAsset, capabilities: MediaCapabilities): void {
    if (!capabilities.formats.includes("nbif-v2")) throw new Error("The device does not support NBIF v2.");
    if (asset.frameCount > capabilities.maxFrames) {
      throw new Error(`Device firmware supports at most ${capabilities.maxFrames} animation frames; this animation has ${asset.frameCount}.`);
    }
    if (asset.durationMs > capabilities.maxDurationMs) {
      throw new Error(`Device firmware supports animations up to ${capabilities.maxDurationMs} ms; this animation is ${asset.durationMs} ms.`);
    }
    if (asset.bytes.length > capabilities.maxEncodedBytes) throw new Error("The converted animation exceeds the device's NBIF v2 file limit.");
  }

  private async uploadAnimationWithOptions(asset: MediaAsset | AnimationAsset, betweenChunks: () => Promise<void>,
                                            signal?: AbortSignal,
                                            onStage?: (stage: AnimationUploadStage) => void): Promise<void> {
    if (signal?.aborted) throw new AnimationReplacementCancelledError();
    const status = await this.status(signal);
    if (asset.bytes[4] !== 2) {
      await this.uploadLegacyAnimation(asset, status.freeStorageBytes);
      return;
    }
    validateAnimationV2(asset.bytes, asset.sha256);
    const animationAsset = asset as AnimationAsset;
    let capabilities: MediaCapabilities | null;
    try { capabilities = await this.animationCapabilities(signal); }
    catch (error) {
      if (error instanceof Error && /invalid media capabilities/i.test(error.message)) throw error;
      throw new Error("Device communication failed; the media capability response was unavailable.");
    }
    if (!capabilities) {
      if (animationAsset.frameCount > 20) {
        throw new Error(`This device supports at most 20 animation frames; this animation has ${animationAsset.frameCount}.`);
      }
      const legacy = animationAsset.legacy ?? createLegacyFallback(animationAsset);
      await this.uploadLegacyAnimation(legacy, status.freeStorageBytes);
      return;
    }
    this.validateAnimationCapacity(animationAsset, capabilities);
    const freeStorageBytes = Math.min(status.freeStorageBytes, capabilities.freeStorageBytes);
    if (asset.bytes.length > capabilities.maxEncodedBytes || asset.bytes.length + capabilities.reserveBytes > freeStorageBytes) {
      throw new AnimationStorageError();
    }

    const startResponse = await this.request("/api/v2/animation/uploads", "POST",
      JSON.stringify({ sizeBytes: asset.bytes.length, sha256: asset.sha256 }),
      { "Content-Type": "application/json" }, this.timeoutMs, [201, 507], false, signal);
    const startValue = await safeResponseJson(startResponse);
    if (startResponse.status === 507) {
      const error = startValue && typeof startValue === "object" ? (startValue as Record<string, unknown>)["code"] : null;
      if (error === "insufficient_storage") throw new AnimationStorageError();
      throw new Error("The device could not reserve safe storage for the animation.");
    }
    if (!startValue || typeof startValue !== "object") throw new Error("The device returned an invalid animation upload session.");
    const start = startValue as Record<string, unknown>;
    if (Object.keys(start).length !== 3 || typeof start["uploadId"] !== "string" || !/^[0-9a-f]{8}$/.test(start["uploadId"]) ||
        start["nextOffset"] !== 0 || start["state"] !== "receiving") throw new Error("The device returned an invalid animation upload session.");
    const uploadId = start["uploadId"];
    const chunkSize = Math.min(ANIMATION_CHUNK_BYTES, capabilities.maxChunkBytes);
    let installed = false;
    try {
      onStage?.("uploading");
      let offset = 0;
      while (offset < asset.bytes.length) {
        if (signal?.aborted) throw new AnimationReplacementCancelledError();
        const end = Math.min(asset.bytes.length, offset + chunkSize);
        const chunk = Buffer.from(asset.bytes.subarray(offset, end));
        try {
          await this.request(`/api/v2/animation/uploads/${uploadId}/chunks?offset=${offset}`, "PUT", chunk,
            { "Content-Type": "application/octet-stream" }, this.hasTimeoutOverride ? this.timeoutMs : 15_000, undefined, false, signal);
          offset = end;
        } catch {
          if (signal?.aborted) throw new AnimationReplacementCancelledError();
          const current = await this.animationUploadStatus(uploadId, signal);
          if (current.state !== "receiving") throw new Error("The animation upload session stopped receiving data.");
          if (current.nextOffset === end) offset = end;
          else if (current.nextOffset === offset) {
            await this.request(`/api/v2/animation/uploads/${uploadId}/chunks?offset=${offset}`, "PUT", chunk,
              { "Content-Type": "application/octet-stream" }, this.hasTimeoutOverride ? this.timeoutMs : 15_000, undefined, false, signal);
            offset = end;
          } else throw new Error("The device animation upload offset is inconsistent.");
        }
        await betweenChunks();
      }
      onStage?.("validating");
      await this.request(`/api/v2/animation/uploads/${uploadId}/complete`, "POST", undefined, {}, this.timeoutMs, [202], false, signal);
      for (let poll = 0; poll < 6000; poll += 1) {
        if (signal?.aborted) throw new AnimationReplacementCancelledError();
        await betweenChunks();
        const current = await this.animationUploadStatus(uploadId, signal);
        if (current.state === "installed") { installed = true; return; }
        if (current.state === "failed") {
          if (current.error === "insufficient_storage") throw new AnimationStorageError();
          throw new Error("The device could not validate or install the animation.");
        }
        if (current.state === "cancelled") throw new Error("The device animation upload was cancelled.");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("The device animation validation timed out.");
    } finally {
      if (!installed) {
        try { await this.request(`/api/v2/animation/uploads/${uploadId}`, "DELETE", undefined, {}, this.timeoutMs); }
        catch { /* A lost connection leaves the bounded session to expire on the device. */ }
      }
    }
  }
}

export class DeviceSynchronizer {
  private pending: Promise<boolean> | null = null;
  private lastUploadControlsAt = 0;
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

  serviceUploadControls(): Promise<void> {
    const now = Date.now();
    if (now - this.lastUploadControlsAt < 5_000) return Promise.resolve();
    this.lastUploadControlsAt = now;
    return this.options.client.serviceUploadControls(this.options.poller.currentSnapshot);
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
