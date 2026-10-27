import type { DeviceIntegration } from "../device/integration.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { parseOAuthCallback } from "../spotify/oauth-callback.js";
import { convertGifToAnimation, createCoverAsset, validateAnimation } from "../media/animation.js";
import type { SpotifyOAuthClient } from "../spotify/oauth.js";
import type { PlaybackPoller } from "../spotify/poller.js";
import type { PlaybackSnapshot } from "../spotify/types.js";
import { resolveActiveScene, type DisplayMode } from "./scene.js";

const JSON_LIMIT_BYTES = 16 * 1024;
const GIF_LIMIT_BYTES = 8 * 1024 * 1024;
const COVER_PIXELS_BYTES = 240 * 240 * 4;
const COVER_SOURCE_LIMIT_BYTES = 2 * 1024 * 1024;
const OAUTH_TIMEOUT_MS = 5 * 60_000;
const PUBLIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/demo-cover.svg": { file: "demo-cover.svg", type: "image/svg+xml; charset=utf-8" },
};

export type MockPlaybackAction = "play" | "pause" | "next" | "offline";

export interface LocalWebAppOptions {
  poller: PlaybackPoller;
  device?: DeviceIntegration;
  oauth: Pick<SpotifyOAuthClient, "createAuthorizationRequest" | "exchangeAuthorizationCode"> | null;
  spotifyConfigured: boolean;
  getDemoEnabled(): boolean;
  setDemoEnabled(enabled: boolean): Promise<void>;
  onMockAction(action: MockPlaybackAction): Promise<void>;
  fetchCover?: typeof fetch;
  port?: number;
  initialMode?: DisplayMode;
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

function isMockAction(value: unknown): value is MockPlaybackAction {
  return value === "play" || value === "pause" || value === "next" || value === "offline";
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

async function downloadSpotifyCover(url: string, fetchCover: typeof fetch): Promise<{ bytes: Buffer; contentType: string }> {
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

function snapshotIsConnected(snapshot: PlaybackSnapshot, spotifyConfigured: boolean, demoEnabled: boolean): boolean {
  return spotifyConfigured && !demoEnabled && snapshot.sampledAtUnixMs > 0 && snapshot.unavailableReason !== "authentication_required";
}

export async function startLocalWebApp(options: LocalWebAppOptions): Promise<LocalWebApp> {
  const configuredPort = options.port ?? 8787;
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) {
    throw new RangeError("The local interface port must be between 0 and 65535.");
  }

  let mode: DisplayMode = options.initialMode ?? "auto";
  let animation: ReturnType<typeof convertGifToAnimation> | null = null;
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
          await options.setDemoEnabled(false);
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
        sendJson(response, 200, {
          mode,
          snapshot,
          activeScene: resolveActiveScene({
            mode,
            snapshot,
            nowUnixMs: Date.now(),
            ...(options.agentTimeoutMs !== undefined ? { timeoutMs: options.agentTimeoutMs } : {}),
          }),
          demoEnabled: options.getDemoEnabled(),
          spotifyConfigured: options.spotifyConfigured,
          spotifyConnected: snapshotIsConnected(snapshot, options.spotifyConfigured, options.getDemoEnabled()),
          animation: animation ? {
            available: true,
            frameCount: animation.frameCount,
            durationMs: animation.durationMs,
            sizeBytes: animation.bytes.length,
            sha256: animation.sha256,
          } : { available: false },
          cover: cover ? { available: true, sizeBytes: cover.bytes.length, sha256: cover.sha256 } : { available: false },
          protocolVersion: "v1",
          device: options.device?.status ?? { address: "", enabled: false, paired: false, connection: "disabled" },
          deviceConnected: options.device?.status.connection === "connected",
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/animation") {
        if (!animation) {
          sendError(response, 404, "Upload a GIF to start the fullscreen preview.");
          return;
        }
        validateAnimation(animation.bytes, animation.sha256);
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

      if (url.pathname === "/api/device") {
        if (!options.device) { sendError(response, 503, "Device configuration is unavailable."); return; }
        try {
          const payload = await readJson(request);
          if (!payload || typeof payload !== "object") throw new Error();
          const item = payload as Record<string, unknown>;
          if (typeof item["address"] !== "string" || typeof item["enabled"] !== "boolean" ||
              (item["token"] !== undefined && typeof item["token"] !== "string")) throw new Error();
          await options.device.configure({ address: item["address"], enabled: item["enabled"],
            ...(typeof item["token"] === "string" ? { token: item["token"] } : {}) });
          response.writeHead(204, securityHeaders()); response.end();
        } catch (error) {
          const message = error instanceof Error && /pairing token|credential manager|valid device HTTP|stopping/.test(error.message)
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
          mode = (payload as { mode: DisplayMode }).mode;
          response.writeHead(204, securityHeaders());
          response.end();
        } catch (error) {
          sendError(response, error instanceof PayloadTooLargeError ? 413 : 400, error instanceof Error ? error.message : "Unable to change the mode.");
        }
        return;
      }

      if (url.pathname === "/api/demo") {
        try {
          const payload = await readJson(request);
          if (typeof payload !== "object" || payload === null || typeof (payload as { enabled?: unknown }).enabled !== "boolean") {
            sendError(response, 422, "Specify whether demo mode should be enabled or disabled.");
            return;
          }
          await options.setDemoEnabled((payload as { enabled: boolean }).enabled);
          await options.poller.pollOnce();
          sendJson(response, 200, { demoEnabled: options.getDemoEnabled() });
        } catch {
          sendError(response, 400, "Unable to toggle demo data.");
        }
        return;
      }

      if (url.pathname === "/api/mock/playback") {
        if (!options.getDemoEnabled()) {
          sendError(response, 409, "Enable demo data before using mock controls.");
          return;
        }
        try {
          const payload = await readJson(request);
          if (typeof payload !== "object" || payload === null || !isMockAction((payload as { action?: unknown }).action)) {
            sendError(response, 422, "Invalid mock action. Use play, pause, next, or offline.");
            return;
          }
          const action = (payload as { action: MockPlaybackAction }).action;
          await options.onMockAction(action);
          await options.poller.pollOnce();
          sendJson(response, 200, { snapshot: options.poller.currentSnapshot });
        } catch {
          sendError(response, 400, "Unable to change demo playback.");
        }
        return;
      }

      if (url.pathname === "/api/animation") {
        if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "image/gif") {
          sendError(response, 415, "Send a GIF file with the image/gif media type.");
          request.resume();
          return;
        }
        try {
          const input = await readBody(request, GIF_LIMIT_BYTES);
          const converted = convertGifToAnimation(input);
          validateAnimation(converted.bytes, converted.sha256);
          animation = converted;
          sendJson(response, 201, {
            width: 240,
            height: 240,
            frameCount: converted.frameCount,
            durationMs: converted.durationMs,
            sizeBytes: converted.bytes.length,
            sha256: converted.sha256,
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
