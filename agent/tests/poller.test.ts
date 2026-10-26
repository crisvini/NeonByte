import assert from "node:assert/strict";
import test from "node:test";
import { PlaybackPoller } from "../src/spotify/poller.js";
import { RateLimitedError } from "../src/spotify/errors.js";
import { MockSpotifyProvider } from "../src/spotify/mock.js";

const track = (progressMs: number) => ({
  is_playing: true,
  progress_ms: progressMs,
  item: {
    type: "track",
    id: "track-1",
    name: "Song",
    duration_ms: 180_000,
    artists: [{ name: "Artist" }],
    album: { images: [{ url: "https://images.example/cover.jpg", width: 300, height: 300 }] },
  },
});

test("poller exposes local state, deduplicates unchanged snapshots, and caches track metadata", async () => {
  const provider = new MockSpotifyProvider(track(10_000));
  let now = 100;
  const poller = new PlaybackPoller({ provider, pollIntervalMs: 15_000, now: () => now });
  const updates: string[] = [];
  poller.subscribe((snapshot) => updates.push(snapshot.status + ":" + (snapshot.nowPlaying?.progressMs ?? "none")));

  await poller.pollOnce();
  now = 200;
  await poller.pollOnce();
  assert.deepEqual(updates, ["playing:10000"]);
  assert.equal(poller.currentSnapshot.status, "playing");
  assert.equal(poller.currentSnapshot.sampledAtUnixMs, 200);
  assert.equal(poller.cachedTrackCount, 1);

  provider.setPlayback(track(25_000));
  await poller.pollOnce();
  assert.deepEqual(updates, ["playing:10000", "playing:25000"]);
  assert.equal(provider.calls, 3);
  assert.equal(poller.cachedTrackCount, 1);
});

test("publishes idle and unavailable transitions and recovers after a transient failure", async () => {
  const provider = new MockSpotifyProvider(track(10_000));
  const poller = new PlaybackPoller({ provider, pollIntervalMs: 15_000, now: () => 200 });
  const states: string[] = [];
  poller.subscribe((snapshot) => states.push(snapshot.status));

  await poller.pollOnce();
  provider.setPlayback(null);
  await poller.pollOnce();
  provider.setError(new Error("network disconnected"));
  await poller.pollOnce();
  assert.equal(poller.currentSnapshot.status, "unavailable");
  assert.equal(poller.nextDelayMs, 2000);

  provider.setError(null);
  provider.setPlayback(track(30_000));
  await poller.pollOnce();
  assert.deepEqual(states, ["playing", "idle", "unavailable", "playing"]);
  assert.equal(poller.nextDelayMs, 15_000);
});

test("honors Retry-After and caps exponential reconnect delay", async () => {
  const provider = new MockSpotifyProvider(null);
  const poller = new PlaybackPoller({
    provider,
    pollIntervalMs: 15_000,
    maxReconnectDelayMs: 60_000,
  });
  provider.setError(new RateLimitedError(22_000));
  await poller.pollOnce();
  assert.equal(poller.nextDelayMs, 22_000);

  provider.setError(new Error("offline"));
  await poller.pollOnce();
  assert.equal(poller.nextDelayMs, 2000);
});

test("mock adapter can reproduce play, pause, and track changes without network access", async () => {
  const provider = new MockSpotifyProvider(track(100));
  assert.equal((await provider.getCurrentPlayback())?.is_playing, true);
  provider.setPlayback({ ...track(100), is_playing: false });
  assert.equal((await provider.getCurrentPlayback())?.is_playing, false);
  provider.setPlayback(track(200));
  assert.equal((await provider.getCurrentPlayback())?.progress_ms, 200);
  assert.equal(provider.calls, 3);
});
