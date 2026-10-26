import { ReauthorizationRequiredError, SpotifyOAuthError } from "./spotify/errors.js";
import { startOAuthCallbackServer } from "./spotify/oauth-callback.js";
import { MockSpotifyProvider } from "./spotify/mock.js";
import { SpotifyOAuthClient } from "./spotify/oauth.js";
import { PlaybackPoller } from "./spotify/poller.js";
import { SpotifyWebApiClient } from "./spotify/spotify-client.js";
import { SystemRefreshTokenStore } from "./spotify/token-store.js";
import type { CurrentPlaybackProvider, SafeLogger, SpotifyCurrentPlayback } from "./spotify/types.js";
import { startLocalWebApp, type MockPlaybackAction } from "./web/server.js";
import type { DisplayMode } from "./web/scene.js";

const logger: SafeLogger = {
  info: (message) => console.info(`[NeonByte] ${message}`),
  warn: (message) => console.warn(`[NeonByte] ${message}`),
  error: (message) => console.error(`[NeonByte] ${message}`),
};

function configuredClientId(): string | null {
  const clientId = process.env["SPOTIFY_CLIENT_ID"]?.trim();
  if (!clientId || clientId === "replace-with-your-spotify-app-client-id") {
    return null;
  }
  return clientId;
}

function requiredClientId(): string {
  const clientId = configuredClientId();
  if (!clientId) {
    throw new SpotifyOAuthError("Configure SPOTIFY_CLIENT_ID no arquivo .env antes de autorizar o Spotify.");
  }
  return clientId;
}

function redirectUri(): string {
  return process.env["SPOTIFY_REDIRECT_URI"]?.trim() || "http://127.0.0.1:8787/callback";
}

function oauthClient(clientId = requiredClientId()): SpotifyOAuthClient {
  return new SpotifyOAuthClient({
    clientId,
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

const demoTracks = [
  { id: "neon-01", title: "Midnight Signals", artist: "Demo Artist", durationMs: 196_000, progressMs: 38_000 },
  { id: "neon-02", title: "Glass Skyline", artist: "Neon Arcade", durationMs: 224_000, progressMs: 74_000 },
  { id: "neon-03", title: "Soft Static", artist: "Satellite Bloom", durationMs: 181_000, progressMs: 12_000 },
];

function demoPlayback(index: number, isPlaying = true): SpotifyCurrentPlayback {
  const track = demoTracks[index % demoTracks.length]!;
  return {
    is_playing: isPlaying,
    progress_ms: track.progressMs,
    item: {
      type: "track",
      id: track.id,
      name: track.title,
      duration_ms: track.durationMs,
      artists: [{ name: track.artist }],
      album: { images: [{ url: "/demo-cover.svg", width: 240, height: 240 }] },
    },
  };
}

function configuredWebPort(): number {
  const redirectPort = Number(new URL(redirectUri()).port);
  const configuredPort = Number(process.env["NEONBYTE_PORT"] ?? redirectPort);
  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535) {
    throw new Error("NEONBYTE_PORT deve ser uma porta entre 1 e 65535.");
  }
  if (configuredPort !== redirectPort) {
    throw new Error("NEONBYTE_PORT precisa corresponder à porta de SPOTIFY_REDIRECT_URI para o callback OAuth local.");
  }
  return configuredPort;
}

function configuredDisplayMode(): DisplayMode {
  const mode = process.env["NEONBYTE_MODE"] ?? "auto";
  if (mode !== "auto" && mode !== "spotify" && mode !== "gif") {
    throw new Error("NEONBYTE_MODE deve ser auto, spotify ou gif.");
  }
  return mode;
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

  const clientId = configuredClientId();
  const oauth = clientId ? oauthClient(clientId) : null;
  const spotify: CurrentPlaybackProvider = oauth
    ? new SpotifyWebApiClient({ tokenProvider: oauth, requestTimeoutMs })
    : { getCurrentPlayback: async () => { throw new ReauthorizationRequiredError(); } };
  const mock = new MockSpotifyProvider(demoPlayback(0));
  let demoEnabled = process.env["NEONBYTE_MOCK"] === "true" || (!oauth && process.env["NEONBYTE_MOCK"] !== "false");
  let demoTrackIndex = 0;
  const provider: CurrentPlaybackProvider = {
    getCurrentPlayback: () => demoEnabled ? mock.getCurrentPlayback() : spotify.getCurrentPlayback(),
  };
  const poller = new PlaybackPoller({
    provider,
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

  const agentTimeoutMs = Number(process.env["NEONBYTE_AGENT_TIMEOUT_MS"] ?? "45000");
  if (!Number.isFinite(agentTimeoutMs) || agentTimeoutMs < 1000) {
    throw new Error("NEONBYTE_AGENT_TIMEOUT_MS deve ser pelo menos 1000.");
  }
  const webApp = await startLocalWebApp({
    poller,
    oauth,
    spotifyConfigured: Boolean(oauth),
    getDemoEnabled: () => demoEnabled,
    setDemoEnabled: async (enabled) => { demoEnabled = enabled; },
    onMockAction: async (action: MockPlaybackAction) => {
      if (action === "offline") {
        mock.setError(new Error("simulated offline"));
      } else if (action === "next") {
        demoTrackIndex = (demoTrackIndex + 1) % demoTracks.length;
        mock.setPlayback(demoPlayback(demoTrackIndex));
      } else {
        mock.setPlayback(demoPlayback(demoTrackIndex, action === "play"));
      }
    },
    port: configuredWebPort(),
    initialMode: configuredDisplayMode(),
    agentTimeoutMs,
  });

  logger.info(`Interface local disponível em ${webApp.url}.`);
  logger.info(`Agente iniciado. Intervalo de consulta: ${pollIntervalMs} ms.${demoEnabled ? " Dados de demonstração ativos." : ""}`);
  poller.start();
  await new Promise<void>((resolve) => {
    const stop = () => {
      poller.stop();
      void webApp.close();
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
