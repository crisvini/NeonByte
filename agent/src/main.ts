import { SpotifyOAuthError } from "./spotify/errors.js";
import { startOAuthCallbackServer } from "./spotify/oauth-callback.js";
import { SpotifyOAuthClient } from "./spotify/oauth.js";
import { PlaybackPoller } from "./spotify/poller.js";
import { SpotifyWebApiClient } from "./spotify/spotify-client.js";
import { SystemRefreshTokenStore } from "./spotify/token-store.js";
import type { SafeLogger } from "./spotify/types.js";

const logger: SafeLogger = {
  info: (message) => console.info(`[NeonByte] ${message}`),
  warn: (message) => console.warn(`[NeonByte] ${message}`),
  error: (message) => console.error(`[NeonByte] ${message}`),
};

function requiredClientId(): string {
  const clientId = process.env["SPOTIFY_CLIENT_ID"]?.trim();
  if (!clientId || clientId === "replace-with-your-spotify-app-client-id") {
    throw new SpotifyOAuthError("Configure SPOTIFY_CLIENT_ID no arquivo .env antes de autorizar o Spotify.");
  }
  return clientId;
}

function redirectUri(): string {
  return process.env["SPOTIFY_REDIRECT_URI"]?.trim() || "http://127.0.0.1:8787/callback";
}

function oauthClient(): SpotifyOAuthClient {
  return new SpotifyOAuthClient({
    clientId: requiredClientId(),
    redirectUri: redirectUri(),
    tokenStore: new SystemRefreshTokenStore(),
  });
}

async function authorizeSpotify(): Promise<void> {
  const oauth = oauthClient();
  const authorization = oauth.createAuthorizationRequest();
  const listener = await startOAuthCallbackServer({
    redirectUri: redirectUri(),
    expectedState: authorization.state,
  });

  try {
    logger.info("Abra este endereço no navegador para autorizar a leitura da reprodução:");
    console.info(authorization.url);
    const callback = await listener.waitForCallback();
    await oauth.exchangeAuthorizationCode({
      code: callback.code,
      codeVerifier: authorization.codeVerifier,
    });
    logger.info("Spotify autorizado. O refresh token foi salvo no cofre seguro do sistema.");
  } finally {
    await listener.close();
  }
}

async function runAgent(): Promise<void> {
  const pollIntervalMs = Number(process.env["SPOTIFY_POLL_INTERVAL_MS"] ?? "15000");
  const requestTimeoutMs = Number(process.env["SPOTIFY_REQUEST_TIMEOUT_MS"] ?? "10000");
  const reconnectMaxMs = Number(process.env["SPOTIFY_RECONNECT_MAX_INTERVAL_MS"] ?? "60000");
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1000) {
    throw new Error("SPOTIFY_POLL_INTERVAL_MS deve ser pelo menos 1000.");
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1000) {
    throw new Error("SPOTIFY_REQUEST_TIMEOUT_MS deve ser pelo menos 1000.");
  }
  if (!Number.isFinite(reconnectMaxMs) || reconnectMaxMs < 1000) {
    throw new Error("SPOTIFY_RECONNECT_MAX_INTERVAL_MS deve ser pelo menos 1000.");
  }

  const oauth = oauthClient();
  const spotify = new SpotifyWebApiClient({ tokenProvider: oauth, requestTimeoutMs });
  const poller = new PlaybackPoller({
    provider: spotify,
    pollIntervalMs,
    maxReconnectDelayMs: reconnectMaxMs,
    logger,
  });
  poller.subscribe((snapshot) => {
    if (snapshot.status === "unavailable") {
      logger.warn(`Estado Spotify indisponível (${snapshot.unavailableReason ?? "api_error"}).`);
      return;
    }
    logger.info(`Estado Spotify atualizado: ${snapshot.status}.`);
  });

  logger.info(`Agente iniciado. Intervalo de consulta: ${pollIntervalMs} ms.`);
  poller.start();
  await new Promise<void>((resolve) => {
    const stop = () => {
      poller.stop();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "auth") {
    await authorizeSpotify();
    return;
  }
  if (command && command !== "run") {
    throw new Error("Comando desconhecido. Use 'auth' para autorizar ou 'run' para iniciar o agente.");
  }
  await runAgent();
}

main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : "Falha inesperada no agente.");
  process.exitCode = 1;
});
