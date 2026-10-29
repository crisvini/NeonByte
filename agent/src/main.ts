import { acquireInstance } from "./instance.js";
import { DeviceIntegration, SystemDeviceConfigStore } from "./device/integration.js";
import { DeviceClient } from "./device/client.js";
import { SystemRecoveryCredentialStore } from "./device/recovery-store.js";
import { MaintenanceClient } from "./device/maintenance-client.js";
import { FirmwareUpdateService, SystemFirmwareUpdateJournal } from "./device/firmware-update.js";
import { runRecoveryEnrollment } from "./device/recovery-enrollment.js";
import { createDeviceConfigurationPrompts, createRecoveryEnrollmentPrompts } from "./device/recovery-enrollment-cli.js";
import { ReauthorizationRequiredError, SpotifyOAuthError } from "./spotify/errors.js";
import { startOAuthCallbackServer } from "./spotify/oauth-callback.js";
import { SpotifyOAuthClient } from "./spotify/oauth.js";
import { PlaybackPoller } from "./spotify/poller.js";
import { SpotifyWebApiClient } from "./spotify/spotify-client.js";
import { SystemRefreshTokenStore } from "./spotify/token-store.js";
import type { CurrentPlaybackProvider, SafeLogger } from "./spotify/types.js";
import { startLocalWebApp } from "./web/server.js";
import { DisplayModeController, FileDisplayModeStore } from "./device/mode-controller.js";

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
    throw new SpotifyOAuthError("Set SPOTIFY_CLIENT_ID in .env before authorizing Spotify.");
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
    logger.info("Open this URL in a browser to authorize playback access:");
    console.info(authorization.url);
    const callback = await listener.waitForCallback();
    await oauth.exchangeAuthorizationCode({
      code: callback.code,
      codeVerifier: authorization.codeVerifier,
    });
    logger.info("Spotify authorized. The refresh token was saved in the system credential manager.");
  } finally {
    await listener.close();
  }
}

async function enrollRecovery(): Promise<void> {
  try {
    const result = await runRecoveryEnrollment({
      prompts: createRecoveryEnrollmentPrompts(),
      deviceStore: new SystemDeviceConfigStore(),
      recoveryStore: new SystemRecoveryCredentialStore(),
    });
    logger.info(`Verified maintenance credentials enrolled for ${result.deviceId}.`);
  } catch {
    logger.error("Maintenance enrollment was not completed. Existing device and Spotify credentials remain unchanged.");
    process.exitCode = 1;
  }
}

async function configureDeviceCredentials(): Promise<void> {
  try {
    const prompts = createDeviceConfigurationPrompts();
    const value = { address: (await prompts.address()).trim(), token: await prompts.token(), enabled: await prompts.enabled() };
    const store = new SystemDeviceConfigStore();
    new DeviceClient({ baseUrl: value.address, token: value.token });
    const previous = await store.get();
    await store.set(value);
    const verified = await store.get();
    if (!verified || verified.address !== value.address || verified.token !== value.token || verified.enabled !== value.enabled) {
      if (previous) await store.set(previous);
      throw new Error();
    }
    logger.info("Device configuration was verified in the system credential manager.");
  } catch {
    logger.error("Device configuration was not completed. Existing Spotify credentials remain unchanged.");
    process.exitCode = 1;
  }
}

function configuredWebPort(): number {
  const redirectPort = Number(new URL(redirectUri()).port);
  const configuredPort = Number(process.env["NEONBYTE_PORT"] ?? redirectPort);
  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535) {
    throw new Error("NEONBYTE_PORT must be a port between 1 and 65535.");
  }
  if (configuredPort !== redirectPort) {
    throw new Error("NEONBYTE_PORT must match the port in SPOTIFY_REDIRECT_URI for the local OAuth callback.");
  }
  return configuredPort;
}

async function runAgent(): Promise<void> {
  const pollIntervalMs = Number(process.env["SPOTIFY_POLL_INTERVAL_MS"] ?? "15000");
  const requestTimeoutMs = Number(process.env["SPOTIFY_REQUEST_TIMEOUT_MS"] ?? "10000");
  const reconnectMaxMs = Number(process.env["SPOTIFY_RECONNECT_MAX_INTERVAL_MS"] ?? "60000");
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1000) {
    throw new Error("SPOTIFY_POLL_INTERVAL_MS must be at least 1000.");
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1000) {
    throw new Error("SPOTIFY_REQUEST_TIMEOUT_MS must be at least 1000.");
  }
  if (!Number.isFinite(reconnectMaxMs) || reconnectMaxMs < 1000) {
    throw new Error("SPOTIFY_RECONNECT_MAX_INTERVAL_MS must be at least 1000.");
  }

  const clientId = configuredClientId();
  const oauth = clientId ? oauthClient(clientId) : null;
  const spotify: CurrentPlaybackProvider = oauth
    ? new SpotifyWebApiClient({ tokenProvider: oauth, requestTimeoutMs })
    : { getCurrentPlayback: async () => { throw new ReauthorizationRequiredError(); } };
  const poller = new PlaybackPoller({
    provider: spotify,
    pollIntervalMs,
    maxReconnectDelayMs: reconnectMaxMs,
    logger,
  });
  poller.subscribe((snapshot) => {
    if (snapshot.status === "unavailable") {
      logger.warn(`Spotify state unavailable (${snapshot.unavailableReason ?? "api_error"}).`);
      return;
    }
    logger.info(`Spotify state updated: ${snapshot.status}.`);
  });

  const agentTimeoutMs = Number(process.env["NEONBYTE_AGENT_TIMEOUT_MS"] ?? "45000");
  if (!Number.isFinite(agentTimeoutMs) || agentTimeoutMs < 1000) {
    throw new Error("NEONBYTE_AGENT_TIMEOUT_MS must be at least 1000.");
  }
  const recoveryStore = new SystemRecoveryCredentialStore();
  const modeController = new DisplayModeController(new FileDisplayModeStore(), "auto");
  await modeController.initialize();
  if (modeController.view.syncState === "failed") logger.warn(modeController.view.message);
  const device = new DeviceIntegration({ store: new SystemDeviceConfigStore(), recoveryStore, poller,
    modeController, intervalMs: 15_000 });
  const firmwareUpdate = new FirmwareUpdateService({ recoveryStore, journal: new SystemFirmwareUpdateJournal(), device,
    createClient: (address, token) => new MaintenanceClient({ baseUrl: address, token }) });
  try { await firmwareUpdate.restore(); }
  catch { logger.warn("Firmware update recovery state is unavailable; dashboard updates require a protected local journal."); }
  const webApp = await startLocalWebApp({
    poller,
    device,
    modeController,
    firmwareUpdate,
    oauth,
    spotifyConfigured: Boolean(oauth),
    port: configuredWebPort(),
    agentTimeoutMs,
  });

  logger.info(`Local interface available at ${webApp.url}.`);
  logger.info(`Agent started. Polling interval: ${pollIntervalMs} ms.`);
  poller.start();
  try { await device.start(); }
  catch { logger.warn("Device configuration is unavailable; device connectivity is disabled."); }
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      poller.stop();
      void Promise.all([device.stop(), webApp.close()]).then(() => resolve(), () => {
        logger.error("Unable to shut down the local agent cleanly.");
        resolve();
      });
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
  if (command === "enroll-recovery") {
    const instance = await acquireInstance();
    try { await enrollRecovery(); } finally { await instance.close(); }
    return;
  }
  if (command === "configure-device") {
    const instance = await acquireInstance();
    try { await configureDeviceCredentials(); } finally { await instance.close(); }
    return;
  }
  if (command && command !== "run") {
    throw new Error("Unknown command. Use 'auth', 'configure-device', 'enroll-recovery', or 'run'.");
  }
  const instance = await acquireInstance();
  try { await runAgent(); } finally { await instance.close(); }
}

main().catch((error: unknown) => {
  logger.error(error instanceof Error && error.message.includes("already running")
    ? "An agent is already running, or the instance port is unavailable."
    : "Agent failed to start or stopped unexpectedly. Check configuration and local port availability.");
  process.exitCode = 1;
});
