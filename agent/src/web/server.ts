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
    throw new Error("Envie os dados usando Content-Type application/json.");
  }
  const body = await readBody(request, limit);
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new Error("O corpo da requisição contém JSON inválido.");
  }
}

async function downloadSpotifyCover(url: string, fetchCover: typeof fetch): Promise<{ bytes: Buffer; contentType: string }> {
  let source: URL;
  try {
    source = new URL(url);
  } catch {
    throw new Error("A capa Spotify atual não tem um endereço válido.");
  }
  if (source.protocol !== "https:" || source.hostname !== "i.scdn.co" || source.port || source.username || source.password) {
    throw new Error("A capa foi recusada porque não veio do host de imagens Spotify permitido.");
  }

  let result: Response;
  try {
    result = await fetchCover(source, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error("Não foi possível carregar a capa Spotify. A prévia de texto continua disponível.");
  }
  if (!result.ok) {
    throw new Error("Spotify não disponibilizou a capa atual.");
  }
  const contentType = result.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]).has(contentType)) {
    throw new Error("O formato de capa retornado pelo Spotify não é compatível com a prévia.");
  }
  const declaredLength = Number(result.headers.get("content-length") ?? 0);
  if (declaredLength > COVER_SOURCE_LIMIT_BYTES || !result.body) {
    throw new Error("A capa Spotify excede o limite de 2 MiB para a prévia.");
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
        throw new Error("A capa Spotify excede o limite de 2 MiB para a prévia.");
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
    sendError(response, 404, "Página ou arquivo local não encontrado.");
    return;
  }
  try {
    const content = await readFile(new URL(`./public/${asset.file}`, import.meta.url));
    response.writeHead(200, { ...securityHeaders(), "Content-Type": asset.type });
    response.end(content);
  } catch {
    sendError(response, 500, "A interface local não está disponível. Recompile o agente e tente novamente.");
  }
}

function snapshotIsConnected(snapshot: PlaybackSnapshot, spotifyConfigured: boolean, demoEnabled: boolean): boolean {
  return spotifyConfigured && !demoEnabled && snapshot.sampledAtUnixMs > 0 && snapshot.unavailableReason !== "authentication_required";
}

export async function startLocalWebApp(options: LocalWebAppOptions): Promise<LocalWebApp> {
  const configuredPort = options.port ?? 8787;
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) {
    throw new RangeError("A porta da interface local precisa estar entre 0 e 65535.");
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
        sendError(response, 403, "A interface aceita somente conexões de localhost.");
        return;
      }

      let url: URL;
      try {
        url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      } catch {
        sendError(response, 400, "O endereço local é inválido.");
        return;
      }

      if (request.method === "GET" && url.pathname === "/callback") {
        if (!pendingOAuth || !options.oauth) {
          sendError(response, 400, "Não há uma autorização Spotify aguardando resposta. Inicie o fluxo novamente.");
          return;
        }
        let callback: { code: string };
        try {
          callback = parseOAuthCallback(url, pendingOAuth.state);
        } catch {
          sendError(response, 400, "A resposta Spotify não pôde ser validada. Inicie uma nova autorização.");
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
          deviceConnected: false,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/animation") {
        if (!animation) {
          sendError(response, 404, "Envie um GIF para começar a prévia fullscreen.");
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
          sendError(response, 404, "Ainda não há capa convertida para esta sessão.");
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
          sendError(response, 404, "Não há uma capa Spotify ativa para pré-visualizar.");
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
          sendError(response, 422, error instanceof Error ? error.message : "Não foi possível carregar a capa Spotify.");
        }
        return;
      }

      if (request.method !== "POST" || !url.pathname.startsWith("/api/")) {
        sendError(response, 404, "Rota local não encontrada.");
        return;
      }
      if (!trustedOrigin(request.headers.origin, port)) {
        sendError(response, 403, "A origem da solicitação não é autorizada para alterar a interface local.");
        return;
      }

      if (url.pathname === "/api/auth/connect") {
        request.resume();
        if (!options.oauth || !options.spotifyConfigured) {
          sendError(response, 503, "Configure SPOTIFY_CLIENT_ID e SPOTIFY_REDIRECT_URI em .env antes de conectar a conta.");
          return;
        }
        if (pendingOAuth) {
          sendError(response, 409, "Já existe uma autorização Spotify aguardando resposta.");
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
          sendError(response, 500, "Não foi possível iniciar a autorização Spotify. Confira a configuração local.");
        }
        return;
      }

      if (url.pathname === "/api/mode") {
        try {
          const payload = await readJson(request);
          if (typeof payload !== "object" || payload === null || !isDisplayMode((payload as { mode?: unknown }).mode)) {
            sendError(response, 422, "Escolha um dos modos Auto, Spotify ou GIF.");
            return;
          }
          mode = (payload as { mode: DisplayMode }).mode;
          response.writeHead(204, securityHeaders());
          response.end();
        } catch (error) {
          sendError(response, error instanceof PayloadTooLargeError ? 413 : 400, error instanceof Error ? error.message : "Não foi possível alterar o modo.");
        }
        return;
      }

      if (url.pathname === "/api/demo") {
        try {
          const payload = await readJson(request);
          if (typeof payload !== "object" || payload === null || typeof (payload as { enabled?: unknown }).enabled !== "boolean") {
            sendError(response, 422, "Informe se o modo de demonstração deve ser ativado ou desativado.");
            return;
          }
          await options.setDemoEnabled((payload as { enabled: boolean }).enabled);
          await options.poller.pollOnce();
          sendJson(response, 200, { demoEnabled: options.getDemoEnabled() });
        } catch {
          sendError(response, 400, "Não foi possível alternar os dados de demonstração.");
        }
        return;
      }

      if (url.pathname === "/api/mock/playback") {
        if (!options.getDemoEnabled()) {
          sendError(response, 409, "Ative os dados de demonstração antes de usar os controles mock.");
          return;
        }
        try {
          const payload = await readJson(request);
          if (typeof payload !== "object" || payload === null || !isMockAction((payload as { action?: unknown }).action)) {
            sendError(response, 422, "Ação mock inválida. Use play, pause, next ou offline.");
            return;
          }
          const action = (payload as { action: MockPlaybackAction }).action;
          await options.onMockAction(action);
          await options.poller.pollOnce();
          sendJson(response, 200, { snapshot: options.poller.currentSnapshot });
        } catch {
          sendError(response, 400, "Não foi possível alterar a reprodução de demonstração.");
        }
        return;
      }

      if (url.pathname === "/api/animation") {
        if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "image/gif") {
          sendError(response, 415, "Envie um arquivo GIF com tipo image/gif.");
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
          sendError(response, error instanceof PayloadTooLargeError ? 413 : 422, error instanceof Error ? error.message : "Não foi possível converter o GIF.");
        }
        return;
      }

      if (url.pathname === "/api/cover") {
        const contentType = request.headers["content-type"]?.toLowerCase();
        if (contentType !== "application/vnd.neonbyte.rgba; width=240; height=240") {
          sendError(response, 415, "Envie pixels RGBA para uma capa de 240 × 240.");
          request.resume();
          return;
        }
        try {
          const pixels = await readBody(request, COVER_PIXELS_BYTES);
          if (pixels.length !== COVER_PIXELS_BYTES) {
            sendError(response, 422, "A capa precisa conter exatamente 240 × 240 pixels RGBA.");
            return;
          }
          cover = createCoverAsset(pixels, 240, 240);
          sendJson(response, 201, { width: 240, height: 240, sizeBytes: cover.bytes.length, sha256: cover.sha256 });
        } catch (error) {
          sendError(response, error instanceof PayloadTooLargeError ? 413 : 400, error instanceof Error ? error.message : "Não foi possível converter a capa.");
        }
        return;
      }

      sendError(response, 404, "Rota local não encontrada.");
    })().catch(() => {
      if (!response.headersSent) {
        sendError(response, 500, "A solicitação local falhou sem alterar credenciais Spotify.");
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
    throw new Error("Não foi possível iniciar a interface local.");
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
