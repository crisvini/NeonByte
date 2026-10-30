import type { DeviceIntegration } from "../device/integration.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { parseOAuthCallback } from "../spotify/oauth-callback.js";
import { convertGifToAnimationV2InWorker, createCoverAsset, type AnimationAsset } from "../media/animation.js";
import { validateAnimationV2 } from "../media/animation-decoder.js";
import { NBIF_V2_MAX_FILE_BYTES } from "../media/animation-format.js";
import type { SpotifyOAuthClient } from "../spotify/oauth.js";
import type { PlaybackPoller } from "../spotify/poller.js";
import type { PlaybackSnapshot } from "../spotify/types.js";
import type { DisplayModeController } from "../device/mode-controller.js";
import { resolveActiveScene, type DisplayMode } from "./scene.js";
import type { FirmwareUpdateService, FirmwareUpdateState, FirmwareUpdateView } from "../device/firmware-update.js";
import { MaintenanceRequestError, MaintenanceTransportError } from "../device/maintenance-client.js";

export type FirmwareUpdateControl = Pick<FirmwareUpdateService, "view" | "getStatus" | "prepare" | "confirm" | "verify" | "correctAddress" | "runApplication" | "reconcileRunning">;

const JSON_LIMIT_BYTES = 16 * 1024;
const GIF_LIMIT_BYTES = 8 * 1024 * 1024;
const COVER_PIXELS_BYTES = 240 * 240 * 4;
const COVER_SOURCE_LIMIT_BYTES = 2 * 1024 * 1024;
const OAUTH_TIMEOUT_MS = 5 * 60_000;
const PUBLIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/neonbyte-logo.webp": { file: "neonbyte-logo.webp", type: "image/webp" },
  "/favicon-32.png": { file: "favicon-32.png", type: "image/png" },
  "/favicon-48.png": { file: "favicon-48.png", type: "image/png" },
};

export interface LocalWebAppOptions {
  poller: PlaybackPoller;
  modeController: DisplayModeController;
  device?: DeviceIntegration;
  firmwareUpdate?: FirmwareUpdateControl;
  oauth: Pick<SpotifyOAuthClient, "createAuthorizationRequest" | "exchangeAuthorizationCode"> | null;
  spotifyConfigured: boolean;
  fetchCover?: typeof fetch;
  port?: number;
  agentTimeoutMs?: number;
}

export interface LocalWebApp {
  port: number;
  url: string;
  close(): Promise<void>;
}

interface PendingOAuth {
  state: string;
  codeVerifier: string;
  timeout: NodeJS.Timeout;
}

class PayloadTooLargeError extends Error {}

function securityHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://accounts.spotify.com",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { ...securityHeaders(), "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { message });
}

function trustedHost(host: string | undefined, port: number): boolean {
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`;
}

function trustedOrigin(origin: string | undefined, port: number): boolean {
  return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
}

function isDisplayMode(value: unknown): value is DisplayMode {
  return value === "auto" || value === "spotify" || value === "gif";
}

function otaLocksMutations(view: FirmwareUpdateView | null | undefined): boolean {
  if (!view) return false;
  if (view.putAttempted) return !["started", "manuallyReconciled"].includes(view.state);
  return !["idle", "started", "manuallyReconciled", "rejected", "transferFailed"].includes(view.state);
}

function rejectOtaMutation(response: ServerResponse, request: IncomingMessage, update: FirmwareUpdateControl | undefined): boolean {
  if (!otaLocksMutations(update?.view)) return false;
  request.resume();
  sendError(response, 423, "Finish or cancel the firmware update before changing device, display, or animation settings.");
  return true;
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    request.resume();
    throw new PayloadTooLargeError();
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > limit) {
      throw new PayloadTooLargeError();
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

async function readJson(request: IncomingMessage, limit = JSON_LIMIT_BYTES): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new Error("Send data using Content-Type application/json.");
  }
  const body = await readBody(request, limit);
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new Error("The request body contains invalid JSON.");
  }
}

export async function downloadSpotifyCover(url: string, fetchCover: typeof fetch): Promise<{ bytes: Buffer; contentType: string }> {
  let source: URL;
  try {
    source = new URL(url);
  } catch {
    throw new Error("The current Spotify cover does not have a valid URL.");
  }
  if (source.protocol !== "https:" || source.hostname !== "i.scdn.co" || source.port || source.username || source.password) {
    throw new Error("The cover was rejected because it did not come from an allowed Spotify image host.");
  }

  let result: Response;
  try {
    result = await fetchCover(source, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error("Unable to load the Spotify cover. The text preview is still available.");
  }
  if (!result.ok) {
    throw new Error("Spotify did not provide the current cover.");
  }
  const contentType = result.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]).has(contentType)) {
    throw new Error("The cover format returned by Spotify is not supported by the preview.");
  }
  const declaredLength = Number(result.headers.get("content-length") ?? 0);
  if (declaredLength > COVER_SOURCE_LIMIT_BYTES || !result.body) {
    throw new Error("The Spotify cover exceeds the 2 MiB preview limit.");
  }

  const reader = result.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes = Buffer.from(chunk.value);
      length += bytes.length;
      if (length > COVER_SOURCE_LIMIT_BYTES) {
        await reader.cancel();
        throw new Error("The Spotify cover exceeds the 2 MiB preview limit.");
      }
      chunks.push(bytes);
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes: Buffer.concat(chunks, length), contentType };
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const asset = PUBLIC_FILES[pathname];
  if (!asset) {
    sendError(response, 404, "Local page or file not found.");
    return;
  }
  try {
    const content = await readFile(new URL(`./public/${asset.file}`, import.meta.url));
    response.writeHead(200, { ...securityHeaders(), "Content-Type": asset.type });
    response.end(content);
  } catch {
    sendError(response, 500, "The local interface is unavailable. Rebuild the agent and try again.");
  }
}

function spotifyConnectionState(snapshot: PlaybackSnapshot, spotifyConfigured: boolean, nowUnixMs: number, timeoutMs: number) {
  if (!spotifyConfigured) return "unconfigured" as const;
  if (snapshot.sampledAtUnixMs <= 0) return "checking" as const;
  if (snapshot.status === "unavailable") {
    if (snapshot.unavailableReason === "authentication_required") return "authentication_required" as const;
    if (snapshot.unavailableReason === "rate_limited") return "rate_limited" as const;
    if (snapshot.unavailableReason === "offline") return "offline" as const;
    return "api_error" as const;
  }
  if (nowUnixMs < snapshot.sampledAtUnixMs || nowUnixMs - snapshot.sampledAtUnixMs > timeoutMs) return "stale" as const;
  return "connected" as const;
}

export async function startLocalWebApp(options: LocalWebAppOptions): Promise<LocalWebApp> {
  const configuredPort = options.port ?? 8787;
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) {
    throw new RangeError("The local interface port must be between 0 and 65535.");
  }

  let animation: AnimationAsset | null = null;
  let animationOriginalSizeBytes = 0;
  let cover: ReturnType<typeof createCoverAsset> | null = null;
  let pendingOAuth: PendingOAuth | null = null;

  const server = createServer((request, response) => {
    void (async () => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : configuredPort;
      if (!trustedHost(request.headers.host, port)) {
        sendError(response, 403, "The interface accepts localhost connections only.");
        return;
      }

      let url: URL;
      try {
        url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      } catch {
        sendError(response, 400, "The local URL is invalid.");
        return;
      }

      if (request.method === "GET" && url.pathname === "/callback") {
        if (!pendingOAuth || !options.oauth) {
          sendError(response, 400, "No Spotify authorization is waiting for a response. Start the flow again.");
          return;
        }
        let callback: { code: string };
        try {
          callback = parseOAuthCallback(url, pendingOAuth.state);
        } catch {
          sendError(response, 400, "The Spotify response could not be validated. Start a new authorization.");
          return;
        }
        const verifier = pendingOAuth.codeVerifier;
        clearTimeout(pendingOAuth.timeout);
        pendingOAuth = null;
        try {
          await options.oauth.exchangeAuthorizationCode({ code: callback.code, codeVerifier: verifier });
          await options.poller.pollOnce();
          response.writeHead(303, { ...securityHeaders(), Location: "/?connected=1" });
          response.end();
        } catch {
          response.writeHead(303, { ...securityHeaders(), Location: "/?error=spotify" });
          response.end();
        }
        return;
      }

      if (request.method === "GET" && PUBLIC_FILES[url.pathname]) {
        await serveStatic(url.pathname, response);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/status") {
        const snapshot = options.poller.currentSnapshot;
        const modeControl = options.modeController.view;
        const spotifyState = spotifyConnectionState(snapshot, options.spotifyConfigured, Date.now(), options.agentTimeoutMs ?? 45_000);
        sendJson(response, 200, {
          mode: modeControl.mode,
          modeControl,
          snapshot,
          activeScene: resolveActiveScene({
            mode: modeControl.mode,
            snapshot,
            nowUnixMs: Date.now(),
            ...(options.agentTimeoutMs !== undefined ? { timeoutMs: options.agentTimeoutMs } : {}),
          }),
          spotifyConfigured: options.spotifyConfigured,
          spotifyConnected: spotifyState === "connected",
          spotifyState,
          spotifyAuthorizing: Boolean(pendingOAuth),
          animation: animation ? {
            available: true,
            width: 240,
            height: 240,
            frameCount: animation.frameCount,
            durationMs: animation.durationMs,
            sizeBytes: animation.bytes.length,
            sha256: animation.sha256,
            originalSizeBytes: animationOriginalSizeBytes,
            compressionPercent: animationOriginalSizeBytes > 0 ? (1 - animation.bytes.length / animationOriginalSizeBytes) * 100 : 0,
            previewSha256: animation.sha256,
          } : { available: false },
          cover: cover ? { available: true, sizeBytes: cover.bytes.length, sha256: cover.sha256 } : { available: false },
          protocolVersion: "v1",
          device: options.device?.status ?? { address: "", enabled: false, paired: false, connection: "disabled",
            mode: null, activeScene: null, lastObservedAtUnixMs: null,
            animation: { state: "none", attempts: 0, previousAnimation: "unchanged", freeStorageBytes: null, message: "" } },
          deviceConnected: options.device?.status.connection === "connected",
          firmwareUpdate: options.firmwareUpdate?.view ?? null,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/ota/status") {
        sendJson(response, 200, options.firmwareUpdate ? await options.firmwareUpdate.getStatus() : { state: "idle", candidate: null, bytesSent: 0, totalBytes: 0,
          message: "Dashboard firmware updates are unavailable.", putAttempted: false, effectiveAddress: "" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/animation") {
        if (!animation) {
          sendError(response, 404, "Upload a GIF to start the fullscreen preview.");
          return;
        }
        response.writeHead(200, {
          ...securityHeaders(),
          "Content-Type": "application/vnd.neonbyte.animation",
          "Content-Length": String(animation.bytes.length),
          "X-Content-SHA256": animation.sha256,
        });
        response.end(animation.bytes);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/cover") {
        if (!cover) {
          sendError(response, 404, "No converted cover is available for this session yet.");
          return;
        }
        response.writeHead(200, {
          ...securityHeaders(),
          "Content-Type": "application/vnd.neonbyte.cover",
          "Content-Length": String(cover.bytes.length),
          "X-Content-SHA256": cover.sha256,
        });
        response.end(cover.bytes);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/cover/source") {
        const coverUrl = options.poller.currentSnapshot.coverUrl;
        if (!coverUrl) {
          sendError(response, 404, "There is no active Spotify cover to preview.");
          return;
        }
        try {
          const source = await downloadSpotifyCover(coverUrl, options.fetchCover ?? fetch);
          response.writeHead(200, {
            ...securityHeaders(),
            "Content-Type": source.contentType,
            "Content-Length": String(source.bytes.length),
          });
          response.end(source.bytes);
        } catch (error) {
          sendError(response, 422, error instanceof Error ? error.message : "Unable to load the Spotify cover.");
        }
        return;
      }

      if (request.method !== "POST" || !url.pathname.startsWith("/api/")) {
        sendError(response, 404, "Local route not found.");
        return;
      }
      if (!trustedOrigin(request.headers.origin, port)) {
        sendError(response, 403, "The request origin is not authorized to modify the local interface.");
        return;
      }

      if (url.pathname.startsWith("/api/ota/")) {
        if (!options.firmwareUpdate) { request.resume(); sendError(response, 503, "Dashboard firmware updates are unavailable."); return; }
        try {
          if (url.pathname === "/api/ota/prepare") {
            if (Number(request.headers["content-length"] ?? 0) !== 0 || request.headers["transfer-encoding"]) {
              request.resume(); sendError(response, 400, "Firmware preparation accepts no browser-supplied files or paths."); return;
            }
            sendJson(response, 200, await options.firmwareUpdate.prepare());
            return;
          }
          if (url.pathname === "/api/ota/confirm") {
            const payload = await readJson(request);
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
            const item = payload as Record<string, unknown>;
            const keys = Object.keys(item);
            const experimentalTestConfirmed = item["experimentalTestConfirmed"] === true;
            const deviceGeometryConfirmed = item["deviceGeometryConfirmed"] === true;
            if ((!keys.every((key) => ["candidateId", "experimentalTestConfirmed", "deviceGeometryConfirmed"].includes(key)) ||
                (Object.hasOwn(item, "experimentalTestConfirmed") && !experimentalTestConfirmed) ||
                (Object.hasOwn(item, "deviceGeometryConfirmed") && (!deviceGeometryConfirmed || !experimentalTestConfirmed)) ||
                !/^[0-9a-f-]{36}$/.test(String(item["candidateId"])))) throw new Error();
            sendJson(response, 200, await options.firmwareUpdate.confirm(item["candidateId"] as string, experimentalTestConfirmed, deviceGeometryConfirmed));
            return;
          }
          if (url.pathname === "/api/ota/address") {
            const payload = await readJson(request);
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
            const item = payload as Record<string, unknown>;
            if (Object.keys(item).length !== 1 || typeof item["address"] !== "string") throw new Error();
            sendJson(response, 200, await options.firmwareUpdate.correctAddress(item["address"]));
            return;
          }
          if (url.pathname === "/api/ota/reconcile") {
            const payload = await readJson(request);
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
            const item = payload as Record<string, unknown>;
            if (Object.keys(item).length !== 2 || item["confirmed"] !== true ||
                typeof item["expectedBuildId"] !== "string" || !/^[A-Za-z0-9._:-]{1,96}$/.test(item["expectedBuildId"])) throw new Error();
            sendJson(response, 200, await options.firmwareUpdate.reconcileRunning(item["expectedBuildId"], true));
            return;
          }
          if (url.pathname === "/api/ota/verify" || url.pathname === "/api/ota/run") {
            if (Number(request.headers["content-length"] ?? 0) !== 0 || request.headers["transfer-encoding"]) {
              request.resume(); sendError(response, 400, "This maintenance action accepts no request body."); return;
            }
            if (url.pathname.endsWith("/verify")) sendJson(response, 200, await options.firmwareUpdate.verify());
            else sendJson(response, 200, await options.firmwareUpdate.runApplication());
            return;
          }
          request.resume(); sendError(response, 404, "Local route not found.");
        } catch (error) {
          const message = error instanceof MaintenanceRequestError || error instanceof MaintenanceTransportError ||
            (error instanceof Error && /^(Prepare firmware again|A firmware update operation|A firmware update|Explicit experimental authorization|Deferred device geometry confirmation|There is no attempted firmware|Only verified firmware|Maintenance credentials required|Maintenance credentials could|Verify, explicitly start|Confirm the expected build|The device cannot be reconciled|The previous firmware transfer|The protected firmware update journal|The protected update history|The reconciled device|The enrolled recovery identity|The responding device|The device identity|The device does not|The device is not|The firmware target|This device build|The application did not|Running-firmware reconciliation failed)/.test(error.message))
            ? error.message : "The maintenance operation was not completed. Check update status before taking another action.";
          sendError(response, 409, message);
        }
        return;
      }

      if (rejectOtaMutation(response, request, options.firmwareUpdate)) return;

      if (url.pathname === "/api/animation/replace") {
        if (Number(request.headers["content-length"] ?? 0) !== 0 || request.headers["transfer-encoding"]) {
          request.resume(); sendError(response, 400, "Animation replacement accepts no request body."); return;
        }
        if (!animation) { sendError(response, 409, "Choose and convert a GIF before replacing the device animation."); return; }
        if (!options.device) { sendError(response, 503, "Device animation replacement is unavailable."); return; }
        try {
          options.device.replaceAnimation();
          sendJson(response, 202, { state: options.device.status.animation.state });
        } catch (error) {
          sendError(response, 409, error instanceof Error ? error.message : "The animation replacement could not be started.");
        }
        return;
      }

      if (url.pathname === "/api/animation/cancel") {
        if (Number(request.headers["content-length"] ?? 0) !== 0 || request.headers["transfer-encoding"]) {
          request.resume(); sendError(response, 400, "Animation cancellation accepts no request body."); return;
        }
        if (!options.device?.cancelAnimationReplacement()) {
          sendError(response, 409, "There is no animation replacement to cancel."); return;
        }
        response.writeHead(204, securityHeaders()); response.end();
        return;
      }

      if (url.pathname === "/api/device") {
        if (!options.device) { sendError(response, 503, "Device configuration is unavailable."); return; }
        try {
          const payload = await readJson(request);
          if (!payload || typeof payload !== "object") throw new Error();
          const item = payload as Record<string, unknown>;
          if (Object.keys(item).length !== 2 || typeof item["address"] !== "string" || typeof item["enabled"] !== "boolean") throw new Error();
          await options.device.configure({ address: item["address"], enabled: item["enabled"] });
          response.writeHead(204, securityHeaders()); response.end();
        } catch (error) {
          const message = error instanceof Error && /pairing token|credential manager|valid device HTTP|stopping|maintenance is in progress/.test(error.message)
            ? error.message : "Unable to update device configuration.";
          sendError(response, error instanceof PayloadTooLargeError ? 413 : 400, message);
        }
        return;
      }

      if (url.pathname === "/api/auth/connect") {
        request.resume();
        if (!options.oauth || !options.spotifyConfigured) {
          sendError(response, 503, "Set SPOTIFY_CLIENT_ID and SPOTIFY_REDIRECT_URI in .env before connecting the account.");
          return;
        }
        if (pendingOAuth) {
          sendError(response, 409, "A Spotify authorization is already waiting for a response.");
          return;
        }
        try {
          const authorization = options.oauth.createAuthorizationRequest();
          const timeout = setTimeout(() => {
            if (pendingOAuth?.state === authorization.state) {
              pendingOAuth = null;
            }
          }, OAUTH_TIMEOUT_MS);
          pendingOAuth = { state: authorization.state, codeVerifier: authorization.codeVerifier, timeout };
          sendJson(response, 200, { url: authorization.url });
        } catch {
          sendError(response, 500, "Unable to start Spotify authorization. Check the local configuration.");
        }
        return;
      }

      if (url.pathname === "/api/mode") {
        try {
          const payload = await readJson(request);
          if (typeof payload !== "object" || payload === null || !isDisplayMode((payload as { mode?: unknown }).mode)) {
            sendError(response, 422, "Select one of the Auto, Spotify, or GIF modes.");
            return;
          }
          await options.modeController.selectManual((payload as { mode: DisplayMode }).mode,
            options.device?.modeTargetFingerprint ?? null);
          options.device?.requestModeSynchronization();
          response.writeHead(204, securityHeaders());
          response.end();
        } catch (error) {
          sendError(response, error instanceof PayloadTooLargeError ? 413 : 400, error instanceof Error ? error.message : "Unable to change the mode.");
        }
        return;
      }

      if (url.pathname === "/api/animation" || url.pathname === "/api/animation/prepared") {
        const restoring = url.pathname === "/api/animation/prepared";
        const mediaType = restoring ? "application/vnd.neonbyte.animation" : "image/gif";
        if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== mediaType) {
          sendError(response, 415, `Send animation data with the ${mediaType} media type.`);
          request.resume();
          return;
        }
        try {
          const input = await readBody(request, restoring ? NBIF_V2_MAX_FILE_BYTES : GIF_LIMIT_BYTES);
          let converted: AnimationAsset;
          const originalSizeBytes = restoring ? Number(request.headers["x-original-size-bytes"] ?? 0) : input.byteLength;
          if (restoring) {
            const sha256 = request.headers["x-content-sha256"];
            if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Provide the prepared animation's lowercase SHA-256.");
            if (!Number.isSafeInteger(originalSizeBytes) || originalSizeBytes < 0 || originalSizeBytes > GIF_LIMIT_BYTES) {
              throw new Error("Provide a valid original GIF size or omit it.");
            }
            const metadata = validateAnimationV2(input, sha256);
            converted = { bytes: input, sha256, frameCount: metadata.frameCount, durationMs: metadata.durationMs };
          } else converted = await convertGifToAnimationV2InWorker(input);
          const metadata = validateAnimationV2(converted.bytes, converted.sha256);
          if (metadata.width !== 240 || metadata.height !== 240 || metadata.frameCount !== converted.frameCount || metadata.durationMs !== converted.durationMs) {
            throw new Error("The converted NBIF v2 animation failed its local metadata validation.");
          }
          options.device?.setAnimation(converted);
          animation = converted;
          animationOriginalSizeBytes = originalSizeBytes;
          sendJson(response, 201, {
            width: metadata.width,
            height: metadata.height,
            frameCount: converted.frameCount,
            durationMs: converted.durationMs,
            sizeBytes: converted.bytes.length,
            sha256: converted.sha256,
            originalSizeBytes,
            compressionPercent: originalSizeBytes > 0 ? (1 - converted.bytes.length / originalSizeBytes) * 100 : 0,
            previewSha256: converted.sha256,
          });
        } catch (error) {
          sendError(response, error instanceof PayloadTooLargeError ? 413 : 422, error instanceof Error ? error.message : "Unable to convert the GIF.");
        }
        return;
      }

      if (url.pathname === "/api/cover") {
        const contentType = request.headers["content-type"]?.toLowerCase();
        if (contentType !== "application/vnd.neonbyte.rgba; width=240; height=240") {
          sendError(response, 415, "Send RGBA pixels for a 240 × 240 cover.");
          request.resume();
          return;
        }
        try {
          const pixels = await readBody(request, COVER_PIXELS_BYTES);
          if (pixels.length !== COVER_PIXELS_BYTES) {
            sendError(response, 422, "The cover must contain exactly 240 × 240 RGBA pixels.");
            return;
          }
          cover = createCoverAsset(pixels, 240, 240);
          sendJson(response, 201, { width: 240, height: 240, sizeBytes: cover.bytes.length, sha256: cover.sha256 });
        } catch (error) {
          sendError(response, error instanceof PayloadTooLargeError ? 413 : 400, error instanceof Error ? error.message : "Unable to convert the cover.");
        }
        return;
      }

      sendError(response, 404, "Local route not found.");
    })().catch(() => {
      if (!response.headersSent) {
        sendError(response, 500, "The local request failed without changing Spotify credentials.");
      } else {
        response.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(configuredPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Unable to start the local interface.");
  }
  const url = `http://localhost:${address.port}`;

  return {
    port: address.port,
    url,
    close: async () => {
      if (pendingOAuth) {
        clearTimeout(pendingOAuth.timeout);
        pendingOAuth = null;
      }
      if (server.listening) {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    },
  };
}
