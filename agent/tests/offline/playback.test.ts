import assert from "node:assert/strict";
import test from "node:test";
import { createCoverAsset, convertGifToAnimation } from "../../src/media/animation.js";
import { MockSpotifyProvider } from "../../src/spotify/mock.js";
import { PlaybackPoller } from "../../src/spotify/poller.js";
import { SpotifyWebApiClient } from "../../src/spotify/spotify-client.js";
import { DeviceClient, DeviceSynchronizer } from "../../src/device/client.js";
import { startHarness, EPOCH } from "./harness.js";

const playback = (id = "track/one", playing = true, progress = 12_000) => ({
  is_playing: playing, progress_ms: progress,
  item: { type: "track", id, name: "Neon Signals", duration_ms: 180_000,
    artists: [{ name: "Demo Artist" }], album: { images: [{ url: `https://i.scdn.co/${id}` }] } },
});
const cover = createCoverAsset(Uint8Array.from([255, 0, 0, 255]), 1, 1);
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

test("native firmware receives agent metadata, artwork, progress corrections, and scene changes", async (t) => {
  const harness = await startHarness(t);
  let now = EPOCH;
  const provider = new MockSpotifyProvider(playback());
  const poller = new PlaybackPoller({ provider, pollIntervalMs: 15_000, now: () => now });
  const client = new DeviceClient({ baseUrl: harness.url, token: harness.token });
  const sync = new DeviceSynchronizer({ client, poller, loadCover: async () => cover });
  await poller.pollOnce();
  await sync.synchronize();
  let state = await harness.state();
  assert.equal(state.scene, "spotify");
  assert.equal(state.title, "Neon Signals");
  assert.equal(state.artist, "Demo Artist");
  assert.equal(state.coverPixel, 0xf800);
  assert.equal(state.progressMs, 12_000);
  await harness.advance(5_000); now += 5_000;
  assert.equal((await harness.state()).progressMs, 17_000);
  provider.setPlayback(playback("track/one", true, 50_000));
  await poller.pollOnce(); await sync.synchronize();
  assert.equal((await harness.state()).progressMs, 50_000);
  provider.setPlayback(playback("track/two"));
  await poller.pollOnce(); await sync.synchronize();
  assert.equal((await harness.state()).coverTrackId, "track/two");
  provider.setPlayback(playback("track/two", false));
  await poller.pollOnce(); await sync.synchronize();
  assert.equal((await harness.state()).scene, "gif");
  await client.setMode("spotify");
  assert.equal((await harness.state()).waiting, true);
  await client.setMode("gif");
  provider.setPlayback(playback()); await poller.pollOnce(); await sync.synchronize();
  assert.equal((await harness.state()).scene, "gif");
  await client.setMode("auto");
  provider.setPlayback(null); await poller.pollOnce(); await sync.synchronize();
  assert.equal((await harness.state()).scene, "gif");
  await client.uploadAnimation(convertGifToAnimation(gif));
  assert.equal((await harness.state()).animationFrames, 1);
});

test("periodic synchronization refreshes deduplicated playback and agent loss expires at the boundary", async (t) => {
  const harness = await startHarness(t);
  let now = EPOCH;
  const provider = new MockSpotifyProvider(playback());
  const poller = new PlaybackPoller({ provider, pollIntervalMs: 15_000, now: () => now });
  const client = new DeviceClient({ baseUrl: harness.url, token: harness.token });
  const sync = new DeviceSynchronizer({ client, poller });
  let changes = 0; poller.subscribe(() => { changes += 1; });
  await poller.pollOnce(); await sync.synchronize();
  for (let index = 1; index <= 6; index += 1) {
    await harness.advance(15_000); now += 15_000;
    provider.setPlayback(playback("track/one", true, 12_000 + index * 15_000));
    await poller.pollOnce(); await sync.synchronize();
    assert.equal((await harness.state()).scene, "spotify");
  }
  assert.equal(changes, 1);
  await harness.advance(45_000);
  assert.equal((await harness.state()).scene, "spotify");
  await harness.advance(1);
  assert.equal((await harness.state()).scene, "gif");
  assert.equal((await harness.state()).agentAvailable, false);
  await client.setMode("spotify");
  assert.equal((await harness.state()).waiting, true);
});

test("mocked Spotify HTTP responses propagate through the real API client, poller, and native firmware", async (t) => {
  const harness = await startHarness(t);
  const responses = [
    new Response(JSON.stringify(playback()), { status: 200 }),
    new Response(null, { status: 204 }),
    new Response(null, { status: 429, headers: { "Retry-After": "60" } }),
    new Response(null, { status: 401 }),
    new Response(JSON.stringify(playback("refreshed")), { status: 200 }),
  ];
  const refreshes: boolean[] = [];
  const api = new SpotifyWebApiClient({
    tokenProvider: { getAccessToken: async (refresh = false) => { refreshes.push(refresh); return "public-mock-access-token"; } },
    fetchImpl: async () => { const response = responses.shift(); assert.ok(response); return response; },
  });
  const poller = new PlaybackPoller({ provider: api, pollIntervalMs: 15_000, now: () => EPOCH });
  const sync = new DeviceSynchronizer({ client: new DeviceClient({ baseUrl: harness.url, token: harness.token }), poller });
  await poller.pollOnce(); await sync.synchronize(); assert.equal((await harness.state()).scene, "spotify");
  await poller.pollOnce(); await sync.synchronize(); assert.equal((await harness.state()).scene, "gif");
  await poller.pollOnce(); await sync.synchronize();
  assert.equal(poller.nextDelayMs, 60_000); assert.equal((await harness.state()).scene, "gif");
  await poller.pollOnce(); await sync.synchronize();
  assert.equal((await harness.state()).trackId, "refreshed");
  assert.equal((await harness.state()).scene, "spotify"); assert.equal(refreshes.at(-1), true);
});
