import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSpotifyPlayback } from "../src/spotify/normalize.js";

test("bounds metadata by Unicode code points without splitting surrogate pairs", () => {
  const text = "x".repeat(255) + "🚀" + "discarded";
  const result = normalizeSpotifyPlayback({ item: {
    type: "track", id: text, name: text, artists: [{ name: text }],
  } }, 1);
  assert.ok(result);
  for (const value of [result.nowPlaying.trackId, result.nowPlaying.title, result.nowPlaying.artist]) {
    assert.equal(value, "x".repeat(255) + "🚀");
    assert.equal([...value].length, 256);
  }
});

test("normalizes a Spotify track into the exact v1 contract and keeps cover metadata separate", () => {
  const normalized = normalizeSpotifyPlayback({
    is_playing: true,
    progress_ms: 125_000,
    item: {
      type: "track",
      id: "track-123",
      uri: "spotify:track:track-123",
      name: "A Neon Song",
      duration_ms: 120_000,
      artists: [{ name: "Artist One" }, { name: "Artist Two" }],
      album: {
        images: [
          { url: "https://images.example/small.jpg", width: 64, height: 64 },
          { url: "https://images.example/large.jpg", width: 640, height: 640 },
        ],
      },
    },
  }, 1_790_000_000_000);

  assert.ok(normalized);
  assert.equal(normalized.status, "playing");
  assert.deepEqual(normalized.nowPlaying, {
    trackId: "track-123",
    title: "A Neon Song",
    artist: "Artist One, Artist Two",
    isPlaying: true,
    durationMs: 120_000,
    progressMs: 120_000,
    sampledAtUnixMs: 1_790_000_000_000,
  });
  assert.equal(normalized.coverUrl, "https://images.example/large.jpg");
  assert.deepEqual(Object.keys(normalized.nowPlaying).sort(), [
    "artist",
    "durationMs",
    "isPlaying",
    "progressMs",
    "sampledAtUnixMs",
    "title",
    "trackId",
  ]);
});

test("preserves paused tracks, clamps text lengths, and handles missing progress", () => {
  const normalized = normalizeSpotifyPlayback({
    is_playing: false,
    progress_ms: null,
    item: {
      type: "track",
      id: "track-1",
      name: "T".repeat(300),
      duration_ms: 90_000,
      artists: [{ name: "A".repeat(300) }],
      album: { images: [] },
    },
  }, 42);

  assert.ok(normalized);
  assert.equal(normalized.status, "paused");
  assert.equal(normalized.nowPlaying.isPlaying, false);
  assert.equal(normalized.nowPlaying.title.length, 256);
  assert.equal(normalized.nowPlaying.artist.length, 256);
  assert.equal(normalized.nowPlaying.progressMs, 0);
  assert.equal(normalized.coverUrl, null);
});

test("returns no track for empty playback and ignores non-music items", () => {
  assert.equal(normalizeSpotifyPlayback(null, 1), null);
  assert.equal(normalizeSpotifyPlayback({ is_playing: false, item: null }, 1), null);
  assert.equal(normalizeSpotifyPlayback({
    is_playing: true,
    item: { type: "episode", id: "episode-1", name: "Podcast" },
  }, 1), null);
});
