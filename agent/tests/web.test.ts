import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { validateCover } from "../src/media/animation.js";
import { validateAnimationV2 } from "../src/media/animation-decoder.js";
import type { DeviceIntegration } from "../src/device/integration.js";
import { MockSpotifyProvider } from "../src/spotify/mock.js";
import { PlaybackPoller } from "../src/spotify/poller.js";
import { startLocalWebApp, type FirmwareUpdateControl } from "../src/web/server.js";
import { createTestModeController } from "./helpers/mode-state.js";

const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
const track = (isPlaying = true, index = 0) => ({
  is_playing: isPlaying,
  progress_ms: 12_000,
  item: {
    type: "track",
    id: `mock-track-${index}`,
    name: `Mock Song ${index + 1}`,
    duration_ms: 180_000,
    artists: [{ name: "Demo Artist" }],
    album: { images: [] },
  },
});

async function makeApp(firmwareUpdate?: FirmwareUpdateControl, device?: DeviceIntegration) {
  const provider = new MockSpotifyProvider(track());
  const poller = new PlaybackPoller({ provider, pollIntervalMs: 15_000 });
  await poller.pollOnce();
  const coverFetches: string[] = [];
  let exchanged: { code: string; codeVerifier: string } | undefined;
  const app = await startLocalWebApp({
    poller,
    modeController: await createTestModeController(),
    ...(firmwareUpdate ? { firmwareUpdate } : {}),
    ...(device ? { device } : {}),
    oauth: {
      createAuthorizationRequest: () => ({
        url: "https://accounts.spotify.com/authorize?state=mock-state",
        state: "mock-state",
        codeVerifier: "mock-verifier",
      }),
      exchangeAuthorizationCode: async (value) => { exchanged = value; },
    },
    spotifyConfigured: true,
    fetchCover: async (input) => {
      coverFetches.push(String(input));
      return new Response(Buffer.from("safe cover bytes"), {
        status: 200,
        headers: { "Content-Type": "image/jpeg", "Content-Length": "16" },
      });
    },
    port: 0,
  });
  const origin = `http://127.0.0.1:${app.port}`;
  return { app, origin, poller, provider, exchanged: () => exchanged, coverFetches };
}

test("serves the local panel and protects mode changes with a loopback origin check", async () => {
  const { app, origin } = await makeApp();
  try {
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /The Windows agent composes the GIF at 240 × 240/);
    assert.match(html, /RGB565 colors with palettes, row compression, and frame differences/);
    assert.match(html, /up to 60 frames/);
    assert.match(html, /20-frame capacity/);
    assert.match(html, /32 KiB reserve/);
    assert.match(html, /id="ota-reconcile"/);
    assert.doesNotMatch(html, /device-token|Pairing token/);

    const rejected = await fetch(`${origin}/api/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "gif" }),
    });
    assert.equal(rejected.status, 403);

    const accepted = await fetch(`${origin}/api/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ mode: "gif" }),
    });
    assert.equal(accepted.status, 204);
    const state = await fetch(`${origin}/api/status`).then((response) => response.json()) as { mode: string; activeScene: string };
    assert.deepEqual({ mode: state.mode, activeScene: state.activeScene }, { mode: "gif", activeScene: "gif" });
  } finally {
    await app.close();
  }
});

test("public panel uses the official branding and has no demonstration controls", async () => {
  const { app, origin } = await makeApp();
  try {
    const page = await fetch(origin).then((response) => response.text());
    assert.match(page, /neonbyte-logo\.webp/);
    assert.match(page, /favicon-32\.png/);
    assert.doesNotMatch(page, /Demo data|mock-playback/i);
    for (const asset of ["/neonbyte-logo.webp", "/favicon-32.png", "/favicon-48.png"]) {
      assert.equal((await fetch(`${origin}${asset}`)).status, 200, `${asset} is served`);
    }
    assert.equal((await fetch(`${origin}/demo-cover.svg`)).status, 404);
    const response = await fetch(`${origin}/api/demo`, { method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) });
    assert.equal(response.status, 404);
    const status = await fetch(`${origin}/api/status`).then((value) => value.json()) as Record<string, unknown>;
    assert.equal("demoEnabled" in status, false);
  } finally { await app.close(); }
});

test("Spotify availability reflects the latest poll instead of stale authorization", async () => {
  const { app, origin, provider, poller } = await makeApp();
  try {
    let state = await fetch(`${origin}/api/status`).then((value) => value.json()) as { spotifyConnected: boolean };
    assert.equal(state.spotifyConnected, true);
    provider.setError(new Error("simulated network outage"));
    await poller.pollOnce();
    state = await fetch(`${origin}/api/status`).then((value) => value.json()) as { spotifyConnected: boolean };
    assert.equal(state.spotifyConnected, false);
  } finally { await app.close(); }
});

test("an unconfigured Spotify account returns no fabricated playback fields", async () => {
  const poller = new PlaybackPoller({ provider: { getCurrentPlayback: async () => null }, pollIntervalMs: 15_000 });
  await poller.pollOnce();
  const app = await startLocalWebApp({ poller, modeController: await createTestModeController(), oauth: null,
    spotifyConfigured: false, port: 0 });
  const origin = `http://127.0.0.1:${app.port}`;
  try {
    const status = await fetch(`${origin}/api/status`).then((response) => response.json()) as {
      spotifyState: string; spotifyConnected: boolean; snapshot: { status: string; nowPlaying: unknown; coverUrl: string | null };
    };
    assert.equal(status.spotifyState, "unconfigured");
    assert.equal(status.spotifyConnected, false);
    assert.equal(status.snapshot.status, "idle");
    assert.equal(status.snapshot.nowPlaying, null);
    assert.equal(status.snapshot.coverUrl, null);
  } finally { await app.close(); }
});

test("Spotify authorization leaves the manually selected display mode unchanged", async () => {
  const { app, origin } = await makeApp();
  try {
    await fetch(`${origin}/api/mode`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "gif" }) });
    const authorization = await fetch(`${origin}/api/auth/connect`, { method: "POST", headers: { Origin: origin },
      body: "" }).then((value) => value.json()) as { url: string };
    assert.match(authorization.url, /accounts\.spotify\.com/);
    const callback = await fetch(`${origin}/callback?code=authorization-code&state=mock-state`, { redirect: "manual" });
    assert.equal(callback.status, 303);
    const status = await fetch(`${origin}/api/status`).then((value) => value.json()) as { mode: string };
    assert.equal(status.mode, "gif");
  } finally { await app.close(); }
});

test("GIF selection only prepares NBIF v2 and the panel starts replacement after explicit confirmation", async () => {
  let prepared = 0;
  let replacements = 0;
  let cancellations = 0;
  const fakeDevice = {
    get status() { return { address: "127.0.0.1", enabled: true, paired: true, connection: "connected",
      animation: { state: "prepared", attempts: 0, previousAnimation: "present" } }; },
    setAnimation(asset: unknown) { prepared += 1; assert.ok(asset && typeof asset === "object"); },
    replaceAnimation() { replacements += 1; },
    cancelAnimationReplacement() { cancellations += 1; return true; },
  } as unknown as DeviceIntegration;
  const { app, origin } = await makeApp(undefined, fakeDevice);
  const post = (path: string) => fetch(`${origin}${path}`, { method: "POST", headers: { Origin: origin } });
  try {
    const page = await fetch(origin).then((response) => response.text());
    assert.match(page, /id="replace-animation"/);
    assert.match(page, /id="cancel-animation"/);
    assert.match(page, /existing animation will be removed/i);
    const conversion = await fetch(`${origin}/api/animation`, { method: "POST",
      headers: { Origin: origin, "Content-Type": "image/gif" }, body: gif });
    assert.equal(conversion.status, 201);
    const preparedAsset = await conversion.json() as { width: number; height: number; frameCount: number; durationMs: number; sizeBytes: number; sha256: string };
    assert.deepEqual({ width: preparedAsset.width, height: preparedAsset.height, frameCount: preparedAsset.frameCount, durationMs: preparedAsset.durationMs },
      { width: 240, height: 240, frameCount: 1, durationMs: 100 });
    assert.ok(preparedAsset.sizeBytes > 0);
    assert.match(preparedAsset.sha256, /^[0-9a-f]{64}$/);
    assert.equal(prepared, 1);
    assert.equal(replacements, 0, "conversion must not remove or upload the installed animation");

    const rejected = await fetch(`${origin}/api/animation/replace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(rejected.status, 403);
    const started = await post("/api/animation/replace");
    assert.equal(started.status, 202);
    assert.equal(replacements, 1);
    assert.equal((await post("/api/animation/cancel")).status, 204);
    assert.equal(cancellations, 1);
  } finally { await app.close(); }
});

test("dashboard OTA accepts only loopback-origin metadata actions and never receives firmware paths or bytes", async () => {
  const candidateId = "11111111-2222-4333-8444-555555555555";
  let prepareCalls = 0;
  let confirmCalls = 0;
  let state: "idle" | "ready" | "rejected" | "transferFailed" | "started" | "manuallyReconciled" = "idle";
  let putAttempted = false;
  const confirmationAcknowledgements: boolean[] = [];
  const candidate = { id: candidateId, fileName: "firmware.bin" as const, byteLength: 4096, sha256: "a".repeat(64),
    expectedBuildId: "build-20261027-a1b2", deviceId: "esp8266-a1b2c3", profile: "esp8266-dio40-4mb",
    purpose: "production" as const, sourceRevision: "1".repeat(40),
    target: { family: "esp8266" as const, flashMode: "dio" as const, flashFrequencyMHz: 40 as const, flashBytes: 4_194_304 as const },
    linkedRegions: { bootloaderStart: 0 as const, applicationStart: 4096 as const, filesystemStart: 1_048_576, filesystemEnd: 4_169_728, eepromStart: 4_173_824 } };
  const update: FirmwareUpdateControl = {
    get view() { return { state, purpose: state === "ready" ? "production" as const : null, sourceRevision: state === "ready" ? candidate.sourceRevision : null,
      candidate: state === "ready" ? candidate : null, bytesSent: 0, totalBytes: 4096,
      message: "Safe update state.", putAttempted, effectiveAddress: "http://192.168.1.20" }; },
    async getStatus() { return this.view; },
    async prepare() { prepareCalls++; state = "ready"; return this.view; },
    async confirm(value, experimentalTestConfirmed = false) {
      confirmCalls++; assert.equal(value, candidateId); confirmationAcknowledgements.push(experimentalTestConfirmed); return this.view;
    },
    async verify() { return this.view; }, async correctAddress() { return this.view; }, async runApplication() { return this.view; },
    async reconcileRunning() { return this.view; },
  };
  const { app, origin } = await makeApp(update);
  const post = (path: string, body?: string, withOrigin = true) => fetch(`${origin}${path}`, { method: "POST",
    headers: { ...(withOrigin ? { Origin: origin } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body } : {}) });
  try {
    assert.equal((await post("/api/ota/prepare", undefined, false)).status, 403);
    assert.equal((await post("/api/ota/prepare", JSON.stringify({ path: "C:\\private\\firmware.bin" }))).status, 400);
    assert.equal(prepareCalls, 0);
    const prepared = await post("/api/ota/prepare");
    assert.equal(prepared.status, 200);
    const visible = await prepared.json() as Record<string, unknown>;
    assert.equal(visible["candidate"] && typeof visible["candidate"] === "object", true);
    assert.equal(JSON.stringify(visible).includes("token"), false);
    assert.equal(JSON.stringify(visible).includes("C:\\private"), false);
    assert.equal((await post("/api/ota/confirm", JSON.stringify({ candidateId: "../../firmware.bin" }))).status, 409);
    assert.equal((await post("/api/ota/confirm", JSON.stringify({ candidateId, experimentalTestConfirmed: false }))).status, 409);
    assert.equal((await post("/api/ota/confirm", JSON.stringify({ candidateId, experimentalTestConfirmed: true, extra: "ignored" }))).status, 409);
    assert.equal(confirmCalls, 0);
    assert.equal((await post("/api/ota/confirm", JSON.stringify({ candidateId, experimentalTestConfirmed: true }))).status, 200);
    assert.deepEqual(confirmationAcknowledgements, [true]);
    assert.equal((await post("/api/ota/confirm", JSON.stringify({ candidateId }))).status, 200);
    assert.deepEqual(confirmationAcknowledgements, [true, false]);
    const blocked = await post("/api/mode", JSON.stringify({ mode: "spotify" }));
    assert.equal(blocked.status, 423);
    assert.equal((await post("/api/animation/prepared")).status, 423);
    for (const terminalState of ["rejected", "transferFailed"] as const) {
      state = terminalState;
      putAttempted = true;
      assert.equal((await post("/api/device", JSON.stringify({ address: "http://192.168.1.20", enabled: true }))).status, 423);
      assert.equal((await post("/api/mode", JSON.stringify({ mode: "gif" }))).status, 423);
    }
    state = "started";
    assert.equal((await post("/api/device", JSON.stringify({ address: "http://192.168.1.20", enabled: true }))).status, 503);
    state = "manuallyReconciled";
    assert.notEqual((await post("/api/mode", JSON.stringify({ mode: "gif" }))).status, 423);
  } finally { await app.close(); }
});

test("dashboard reconciliation requires an explicit confirmed expected build and returns safe OTA errors", async () => {
  let reconciliations = 0;
  const view = { state: "verificationFailed" as const, purpose: "production" as const, sourceRevision: null, candidate: null, bytesSent: 0, totalBytes: 4096,
    message: "Previous update needs review.", putAttempted: true, effectiveAddress: "http://192.168.1.20" };
  const update: FirmwareUpdateControl = {
    view, async getStatus() { return view; },
    async prepare() { throw new Error("Verify, explicitly start, or manually reconcile the previous firmware before preparing another update."); },
    async confirm() { return view; }, async verify() { return view; }, async correctAddress() { return view; }, async runApplication() { return view; },
    async reconcileRunning(buildId, confirmed) { assert.equal(buildId, "build-new"); assert.equal(confirmed, true); reconciliations++; return view; },
  };
  const { app, origin } = await makeApp(update);
  const post = (path: string, body?: unknown, authorized = true) => fetch(`${origin}${path}`, { method: "POST",
    headers: { ...(authorized ? { Origin: origin } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  try {
    const blocked = await post("/api/ota/prepare");
    assert.equal(blocked.status, 409);
    assert.match((await blocked.json() as { message: string }).message, /manually reconcile the previous firmware/);
    assert.equal((await post("/api/ota/reconcile", { expectedBuildId: "build-new", confirmed: true }, false)).status, 403);
    assert.equal((await post("/api/ota/reconcile", { expectedBuildId: "build-new", confirmed: false })).status, 409);
    assert.equal((await post("/api/ota/reconcile", { expectedBuildId: "build-new", confirmed: true, token: "secret" })).status, 409);
    assert.equal(reconciliations, 0);
    assert.equal((await post("/api/ota/reconcile", { expectedBuildId: "build-new", confirmed: true })).status, 200);
    assert.equal(reconciliations, 1);
  } finally { await app.close(); }
});

test("test-only Spotify provider fixtures exercise playback transitions without application demo routes", async () => {
  const { app, origin, provider, poller } = await makeApp();
  try {
    provider.setPlayback(track(false));
    await poller.pollOnce();
    let state = await fetch(`${origin}/api/status`).then((value) => value.json()) as { mode: string; snapshot: { status: string } };
    assert.equal(state.snapshot.status, "paused");
    assert.equal(state.mode, "auto");

    provider.setPlayback(track(true));
    await poller.pollOnce();
    const resumed = await fetch(`${origin}/api/status`).then((value) => value.json()) as { mode: string; snapshot: { status: string; nowPlaying: { trackId: string } } };
    assert.equal(resumed.snapshot.status, "playing");
    const firstTrackId = resumed.snapshot.nowPlaying.trackId;

    provider.setPlayback(track(true, 1));
    await poller.pollOnce();
    const next = await fetch(`${origin}/api/status`).then((value) => value.json()) as { mode: string; snapshot: { nowPlaying: { trackId: string } } };
    assert.notEqual(next.snapshot.nowPlaying.trackId, firstTrackId);
    assert.equal(next.mode, "auto");

    provider.setError(new Error("test fixture outage"));
    await poller.pollOnce();
    state = await fetch(`${origin}/api/status`).then((value) => value.json()) as { mode: string; snapshot: { status: string } };
    assert.equal(state.snapshot.status, "unavailable");
    assert.equal(state.mode, "auto");
    const scene = await fetch(`${origin}/api/status`).then((value) => value.json()) as { activeScene: string };
    assert.equal(scene.activeScene, "gif");
  } finally {
    await app.close();
  }
});

test("manual Spotify mode holds the waiting scene without inventing a playing track", async () => {
  const { app, origin, provider, poller } = await makeApp();
  try {
    provider.setPlayback(null);
    await poller.pollOnce();
    await fetch(`${origin}/api/mode`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "spotify" }),
    });
    const state = await fetch(`${origin}/api/status`).then((response) => response.json()) as { activeScene: string; snapshot: { nowPlaying: unknown } };
    assert.equal(state.activeScene, "spotify");
    assert.equal(state.snapshot.nowPlaying, null);
  } finally {
    await app.close();
  }
});

test("runs PKCE through the same localhost server without returning the authorization code", async () => {
  const { app, origin, exchanged } = await makeApp();
  try {
    const start = await fetch(`${origin}/api/auth/connect`, {
      method: "POST",
      headers: { Origin: origin },
    });
    assert.equal(start.status, 200);
    assert.equal((await start.json() as { url: string }).url, "https://accounts.spotify.com/authorize?state=mock-state");

    const callback = await fetch(`${origin}/callback?code=short-lived-code&state=mock-state`, { redirect: "manual" });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get("location"), "/?connected=1");
    assert.deepEqual(exchanged(), { code: "short-lived-code", codeVerifier: "mock-verifier" });
    assert.doesNotMatch(await callback.text(), /short-lived-code|mock-verifier/);
  } finally {
    await app.close();
  }
});

test("validates GIF uploads and serves the converted fullscreen animation with its checksum", async () => {
  const { app, origin } = await makeApp();
  try {
    const upload = await fetch(`${origin}/api/animation`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "image/gif" },
      body: gif,
    });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json() as { sha256: string; frameCount: number; previewSha256: string };
    assert.equal(uploaded.frameCount, 1);
    assert.equal(uploaded.sha256, uploaded.previewSha256);

    const animationResponse = await fetch(`${origin}/api/animation`);
    assert.equal(animationResponse.status, 200);
    assert.match(animationResponse.headers.get("content-type") ?? "", /application\/vnd\.neonbyte\.animation/);
    const animationBytes = Buffer.from(await animationResponse.arrayBuffer());
    assert.equal(animationBytes.readUInt8(4), 2);
    assert.equal(validateAnimationV2(animationBytes, uploaded.previewSha256).frameCount, 1);

    const invalid = await fetch(`${origin}/api/animation`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "image/gif" },
      body: Buffer.from("bad gif"),
    });
    assert.equal(invalid.status, 422);
    assert.match((await invalid.json() as { message: string }).message, /invalid GIF/i);
  } finally {
    await app.close();
  }
});

test("restores exported NBIF v2 after an agent restart without converting the GIF again", async () => {
  const first = await makeApp();
  let bytes: Buffer;
  let sha256: string;
  try {
    const converted = await fetch(`${first.origin}/api/animation`, { method: "POST",
      headers: { Origin: first.origin, "Content-Type": "image/gif" }, body: gif });
    sha256 = (await converted.json() as { sha256: string }).sha256;
    bytes = Buffer.from(await (await fetch(`${first.origin}/api/animation`)).arrayBuffer());
  } finally { await first.app.close(); }
  const { app, origin } = await makeApp();
  try {
    const restore = (body: Buffer, checksum = sha256, requestOrigin = origin) => fetch(`${origin}/api/animation/prepared`, {
      method: "POST", headers: { Origin: requestOrigin, "Content-Type": "application/vnd.neonbyte.animation",
        "X-Content-SHA256": checksum, "X-Original-Size-Bytes": String(gif.length) }, body });
    assert.equal((await restore(bytes, sha256, "https://example.com")).status, 403);
    assert.equal((await fetch(`${origin}/api/animation`)).status, 404);
    const restored = await restore(bytes);
    assert.equal(restored.status, 201);
    assert.deepEqual(await restored.json(), { width: 240, height: 240, frameCount: 1, durationMs: 100,
      sizeBytes: bytes.length, sha256, originalSizeBytes: gif.length,
      compressionPercent: (1 - bytes.length / gif.length) * 100, previewSha256: sha256 });
    assert.deepEqual(Buffer.from(await (await fetch(`${origin}/api/animation`)).arrayBuffer()), bytes);
    assert.equal((await restore(bytes, "0".repeat(64))).status, 422);
    const invalid = Buffer.from("invalid NBIF");
    assert.equal((await restore(invalid, createHash("sha256").update(invalid).digest("hex"))).status, 422);
    assert.equal((await restore(bytes, "")).status, 422);
    assert.equal((await fetch(`${origin}/api/animation/prepared`, { method: "POST", headers: { Origin: origin,
      "Content-Type": "application/vnd.neonbyte.animation", "X-Content-SHA256": sha256,
      "X-Original-Size-Bytes": "-1" }, body: bytes })).status, 422);
    assert.equal((await restore(Buffer.alloc(2_359_297))).status, 413);
    assert.deepEqual(Buffer.from(await (await fetch(`${origin}/api/animation`)).arrayBuffer()), bytes);
  } finally { await app.close(); }
});

test("a device that rejects GIF preparation does not replace the panel's current preview", async () => {
  const rejectingDevice = { setAnimation() { throw new Error("Finish or cancel the current animation replacement before choosing another GIF."); } } as unknown as DeviceIntegration;
  const { app, origin } = await makeApp(undefined, rejectingDevice);
  try {
    const rejected = await fetch(`${origin}/api/animation`, { method: "POST",
      headers: { Origin: origin, "Content-Type": "image/gif" }, body: gif });
    assert.equal(rejected.status, 422);
    assert.equal((await fetch(`${origin}/api/animation`)).status, 404);
  } finally { await app.close(); }
});

test("converts browser-decoded cover pixels into a checksummed 240 by 240 asset", async () => {
  const { app, origin } = await makeApp();
  try {
    const pixels = Buffer.alloc(240 * 240 * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels[offset] = 25;
      pixels[offset + 1] = 80;
      pixels[offset + 2] = 190;
      pixels[offset + 3] = 255;
    }
    const cover = await fetch(`${origin}/api/cover`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/vnd.neonbyte.rgba; width=240; height=240" },
      body: pixels,
    });
    assert.equal(cover.status, 201);
    const { sha256 } = await cover.json() as { sha256: string };
    const asset = await fetch(`${origin}/api/cover`).then((response) => response.arrayBuffer());
    assert.deepEqual(validateCover(Buffer.from(asset), sha256), { width: 240, height: 240, sha256 });
  } finally {
    await app.close();
  }
});

test("proxies current Spotify cover art locally and rejects URLs outside the Spotify image host", async () => {
  const { app, origin, poller, provider, coverFetches } = await makeApp();
  const playbackWithCover = (url: string) => ({
    ...track(),
    item: { ...track().item, album: { images: [{ url, width: 640, height: 640 }] } },
  });
  try {
    provider.setPlayback(playbackWithCover("https://i.scdn.co/image/mock-cover"));
    await poller.pollOnce();
    const proxied = await fetch(`${origin}/api/cover/source`);
    assert.equal(proxied.status, 200);
    assert.equal(proxied.headers.get("content-type"), "image/jpeg");
    assert.equal(await proxied.text(), "safe cover bytes");
    assert.deepEqual(coverFetches, ["https://i.scdn.co/image/mock-cover"]);

    provider.setPlayback(playbackWithCover("https://example.com/untrusted-image"));
    await poller.pollOnce();
    assert.equal((await fetch(`${origin}/api/cover/source`)).status, 422);
    assert.equal(coverFetches.length, 1);
  } finally {
    await app.close();
  }
});
