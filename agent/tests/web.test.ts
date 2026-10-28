import assert from "node:assert/strict";
import test from "node:test";
import { validateCover } from "../src/media/animation.js";
import { validateAnimationV2 } from "../src/media/animation-decoder.js";
import { MockSpotifyProvider } from "../src/spotify/mock.js";
import { PlaybackPoller } from "../src/spotify/poller.js";
import { startLocalWebApp, type FirmwareUpdateControl } from "../src/web/server.js";

const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
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

async function makeApp(firmwareUpdate?: FirmwareUpdateControl) {
  const provider = new MockSpotifyProvider(track());
  const poller = new PlaybackPoller({ provider, pollIntervalMs: 15_000 });
  await poller.pollOnce();
  let demoEnabled = false;
  let trackIndex = 0;
  const coverFetches: string[] = [];
  let exchanged: { code: string; codeVerifier: string } | undefined;
  const app = await startLocalWebApp({
    poller,
    ...(firmwareUpdate ? { firmwareUpdate } : {}),
    oauth: {
      createAuthorizationRequest: () => ({
        url: "https://accounts.spotify.com/authorize?state=mock-state",
        state: "mock-state",
        codeVerifier: "mock-verifier",
      }),
      exchangeAuthorizationCode: async (value) => { exchanged = value; },
    },
    spotifyConfigured: true,
    getDemoEnabled: () => demoEnabled,
    setDemoEnabled: async (enabled) => { demoEnabled = enabled; },
    onMockAction: async (action) => {
      if (action === "offline") {
        provider.setError(new Error("mock offline"));
      } else if (action === "next") {
        trackIndex += 1;
        provider.setPlayback(track(true, trackIndex));
      } else {
        provider.setPlayback(track(action !== "pause", trackIndex));
      }
    },
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
    assert.match(html, /exact RGB565 colors with palettes, row compression, and frame differences/);
    assert.match(html, /20 frames and 30 seconds/);
    assert.match(html, /32 KiB reserve/);
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

test("dashboard OTA accepts only loopback-origin metadata actions and never receives firmware paths or bytes", async () => {
  const candidateId = "11111111-2222-4333-8444-555555555555";
  let prepareCalls = 0;
  let confirmCalls = 0;
  let state: "idle" | "ready" | "rejected" | "transferFailed" | "started" = "idle";
  let putAttempted = false;
  const candidate = { id: candidateId, fileName: "firmware.bin" as const, byteLength: 4096, sha256: "a".repeat(64),
    expectedBuildId: "build-20261027-a1b2", deviceId: "esp8266-a1b2c3" };
  const update: FirmwareUpdateControl = {
    get view() { return { state, candidate: state === "ready" ? candidate : null, bytesSent: 0, totalBytes: 4096,
      message: "Safe update state.", putAttempted, effectiveAddress: "http://192.168.1.20" }; },
    async getStatus() { return this.view; },
    async prepare() { prepareCalls++; state = "ready"; return this.view; },
    async confirm(value) { confirmCalls++; assert.equal(value, candidateId); return this.view; },
    async verify() { return this.view; }, async correctAddress() { return this.view; }, async runApplication() { return this.view; },
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
    assert.equal(confirmCalls, 0);
    const blocked = await post("/api/mode", JSON.stringify({ mode: "spotify" }));
    assert.equal(blocked.status, 423);
    for (const terminalState of ["rejected", "transferFailed"] as const) {
      state = terminalState;
      putAttempted = true;
      assert.equal((await post("/api/device", JSON.stringify({ address: "http://192.168.1.20", enabled: true }))).status, 423);
      assert.equal((await post("/api/mode", JSON.stringify({ mode: "gif" }))).status, 423);
    }
    state = "started";
    assert.equal((await post("/api/device", JSON.stringify({ address: "http://192.168.1.20", enabled: true }))).status, 503);
  } finally { await app.close(); }
});

test("mock controls switch playback, pause, next track, and simulated agent failure in auto mode", async () => {
  const { app, origin } = await makeApp();
  const post = (path: string, body: unknown) => fetch(`${origin}${path}`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    await post("/api/demo", { enabled: true });
    let response = await post("/api/mock/playback", { action: "pause" });
    assert.equal((await response.json() as { snapshot: { status: string } }).snapshot.status, "paused");

    response = await post("/api/mock/playback", { action: "play" });
    const resumed = await response.json() as { snapshot: { status: string; nowPlaying: { trackId: string } } };
    assert.equal(resumed.snapshot.status, "playing");
    const firstTrackId = resumed.snapshot.nowPlaying.trackId;

    response = await post("/api/mock/playback", { action: "next" });
    const next = await response.json() as { snapshot: { nowPlaying: { trackId: string } } };
    assert.notEqual(next.snapshot.nowPlaying.trackId, firstTrackId);

    response = await post("/api/mock/playback", { action: "offline" });
    assert.equal((await response.json() as { snapshot: { status: string } }).snapshot.status, "unavailable");
    const state = await fetch(`${origin}/api/status`).then((value) => value.json()) as { activeScene: string };
    assert.equal(state.activeScene, "gif");
  } finally {
    await app.close();
  }
});

test("manual Spotify mode holds the waiting scene without inventing a playing track", async () => {
  const { app, origin, provider } = await makeApp();
  try {
    provider.setPlayback(null);
    await fetch(`${origin}/api/mode`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "spotify" }),
    });
    await fetch(`${origin}/api/demo`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
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
