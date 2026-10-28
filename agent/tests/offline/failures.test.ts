import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DeviceClient, DeviceSynchronizer } from "../../src/device/client.js";
import { createCoverAsset } from "../../src/media/animation.js";
import { MockSpotifyProvider } from "../../src/spotify/mock.js";
import { PlaybackPoller } from "../../src/spotify/poller.js";
import { EPOCH, startHarness } from "./harness.js";

const playback = (id = "first", progress = 1_000) => ({
  is_playing: true, progress_ms: progress,
  item: { type: "track", id, name: "Offline Song", duration_ms: 180_000, artists: [{ name: "Offline Artist" }],
    album: { images: [{ url: `https://i.scdn.co/${id}` }] } },
});
const red = createCoverAsset(Uint8Array.from([255, 0, 0, 255]), 1, 1);
const green = createCoverAsset(Uint8Array.from([0, 255, 0, 255]), 1, 1);

test("cover caching avoids redundant transfers, retries failures, and never displays another track's artwork", async (t) => {
  const harness = await startHarness(t);
  const provider = new MockSpotifyProvider(playback());
  const poller = new PlaybackPoller({ provider, pollIntervalMs: 15_000, now: () => EPOCH });
  const client = new DeviceClient({ baseUrl: harness.url, token: harness.token });
  let failCover = false;
  const sync = new DeviceSynchronizer({ client, poller, loadCover: async () => {
    if (failCover) throw new Error("Mock decoder failed.");
    return provider.calls > 1 ? green : red;
  } });
  await poller.pollOnce(); assert.equal(await sync.synchronize(), true);
  assert.equal((await harness.state()).coverPixel, 0xf800);
  await sync.synchronize();
  assert.equal(harness.requests.filter(({ path }) => path === "/api/v1/cover").length, 1);
  provider.setPlayback(playback("second")); await poller.pollOnce(); failCover = true;
  assert.equal(await sync.synchronize(), true);
  let state = await harness.state();
  assert.equal(state.trackId, "second"); assert.equal(state.scene, "spotify");
  assert.equal(state.coverPixel, -1); assert.equal(state.coverTrackId, "first");
  failCover = false; await harness.fault("promote", false);
  assert.equal(await sync.synchronize(), true);
  assert.equal((await harness.state()).coverTrackId, "first");
  await harness.fault("promote", true);
  assert.equal(await sync.synchronize(), true);
  state = await harness.state(); assert.equal(state.coverTrackId, "second"); assert.equal(state.coverPixel, 0x07e0);
  // Cover may arrive before metadata, but must remain hidden until the matching track arrives.
  await client.uploadCover("third/space and 🚀", red);
  assert.equal((await harness.state()).coverPixel, -1);
  provider.setPlayback(playback("third/space and 🚀")); await poller.pollOnce();
  await client.sendPlayback(poller.currentSnapshot);
  assert.equal((await harness.state()).coverPixel, 0xf800);
});

test("agent reconnects after transport loss and reboot without sending updates to incompatible firmware", async (t) => {
  const harness = await startHarness(t);
  let now = EPOCH;
  const provider = new MockSpotifyProvider(playback());
  const poller = new PlaybackPoller({ provider, pollIntervalMs: 15_000, now: () => now });
  const client = new DeviceClient({ baseUrl: harness.url, token: harness.token });
  const sync = new DeviceSynchronizer({ client, poller, loadCover: async () => red });
  await poller.pollOnce(); assert.equal(await sync.synchronize(), true);
  harness.offline = true;
  assert.equal(await sync.synchronize(), false);
  await harness.advance(45_001); now += 45_001;
  assert.equal((await harness.state()).scene, "gif");
  harness.offline = false;
  provider.setPlayback(playback("first", 46_001)); await poller.pollOnce();
  assert.equal(await sync.synchronize(), true);
  assert.equal((await harness.state()).scene, "spotify");
  await harness.restart();
  assert.equal((await harness.state()).scene, "gif");
  await poller.pollOnce();
  assert.equal(await sync.synchronize(), true);
  assert.equal((await harness.state()).scene, "spotify");
  const mutations = harness.requests.filter(({ method }) => method !== "GET").length;
  harness.statusOverride = { protocolVersion: "v2" };
  assert.equal(await sync.synchronize(), false);
  await assert.rejects(client.setMode("gif"), /compatible protocol v1/);
  assert.equal(harness.requests.filter(({ method }) => method !== "GET").length, mutations);
  harness.statusOverride = undefined;
  assert.equal(await sync.synchronize(), true);
});

test("independent metadata expiry, progress clamping, and Spotify unavailability preserve the mode matrix", async (t) => {
  const harness = await startHarness(t);
  let now = EPOCH;
  const provider = new MockSpotifyProvider(playback());
  const poller = new PlaybackPoller({ provider, pollIntervalMs: 15_000, now: () => now });
  const client = new DeviceClient({ baseUrl: harness.url, token: harness.token });
  const sync = new DeviceSynchronizer({ client, poller });
  await poller.pollOnce(); await sync.synchronize();
  await harness.advance(45_001); now += 45_001;
  await client.heartbeat();
  let state = await harness.state(); assert.equal(state.agentAvailable, true); assert.equal(state.scene, "gif");
  provider.setPlayback(playback("first", 999_999)); await poller.pollOnce(); await sync.synchronize();
  state = await harness.state(); assert.equal(state.progressMs, 180_000); assert.equal(state.scene, "spotify");
  provider.setError(new TypeError("Mock Internet unavailable.")); await poller.pollOnce(); await sync.synchronize();
  assert.equal((await harness.state()).scene, "spotify");
  await harness.advance(45_000); now += 45_000;
  await sync.synchronize();
  assert.equal((await harness.state()).scene, "spotify");
  await harness.advance(1); now += 1;
  await sync.synchronize();
  assert.equal((await harness.state()).scene, "gif");
  assert.equal((await harness.state()).agentAvailable, true);
  await client.setMode("spotify"); assert.equal((await harness.state()).waiting, true);
  provider.setPlayback(playback()); await poller.pollOnce(); await sync.synchronize();
  assert.equal((await harness.state()).waiting, false);
});

test("wrong pairing, malformed JSON, ambiguous headers, and corrupt covers leave firmware state unchanged", async (t) => {
  const harness = await startHarness(t);
  const wrong = new DeviceClient({ baseUrl: harness.url, token: "public-invalid-test-token" });
  await assert.rejects(wrong.setMode("spotify"), /communication failed/);
  const body = Buffer.from("{\"mode\":\"spotify\",\"mode\":\"gif\"}");
  let result = await harness.raw(`PUT /api/v1/mode HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${harness.token}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`, body);
  assert.equal(result.status, 400);
  result = await harness.raw("POST /api/v1/heartbeat HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n");
  assert.equal(result.status, 400);
  const corrupt = Buffer.from(red.bytes); corrupt[0] = 0;
  const response = await fetch(`${harness.url}/api/v1/cover`, {
    method: "PUT", headers: { Authorization: `Bearer ${harness.token}`, "Content-Type": "application/octet-stream",
      "X-Track-Id": "first", "X-Content-SHA256": createHash("sha256").update(corrupt).digest("hex") }, body: corrupt,
  });
  assert.equal(response.status, 422);
  const state = await harness.state(); assert.equal(state.scene, "gif"); assert.equal(state.agentAvailable, false);
});

test("Unicode metadata crosses the agent/native boundary without splitting a surrogate pair", async (t) => {
  const harness = await startHarness(t);
  const input = playback();
  input.item.name = "x".repeat(255) + "🚀";
  const provider = new MockSpotifyProvider(input);
  const poller = new PlaybackPoller({ provider, pollIntervalMs: 15_000, now: () => EPOCH });
  await poller.pollOnce();
  const sync = new DeviceSynchronizer({ client: new DeviceClient({ baseUrl: harness.url, token: harness.token }), poller });
  assert.equal(await sync.synchronize(), true);
  assert.equal((await harness.state()).title, "x".repeat(255) + "🚀");
});

test("a restarted agent with no track history relies on the bounded firmware metadata timeout", async (t) => {
  const harness = await startHarness(t);
  const firstPoller = new PlaybackPoller({ provider: new MockSpotifyProvider(playback()), pollIntervalMs: 15_000, now: () => EPOCH });
  await firstPoller.pollOnce();
  const first = new DeviceSynchronizer({ client: new DeviceClient({ baseUrl: harness.url, token: harness.token }), poller: firstPoller });
  await first.synchronize();
  const idlePoller = new PlaybackPoller({ provider: new MockSpotifyProvider(null), pollIntervalMs: 15_000, now: () => EPOCH });
  await idlePoller.pollOnce();
  const restarted = new DeviceSynchronizer({ client: new DeviceClient({ baseUrl: harness.url, token: harness.token }), poller: idlePoller });
  await restarted.synchronize();
  // Known v1 gap: there is no clear-playback route or way to read the previous track ID.
  assert.equal((await harness.state()).scene, "spotify");
  await harness.advance(45_001); await restarted.synchronize();
  const state = await harness.state(); assert.equal(state.scene, "gif"); assert.equal(state.agentAvailable, true);
});
