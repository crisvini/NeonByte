import assert from "node:assert/strict";
import test from "node:test";
import { resolveActiveScene } from "../src/web/scene.js";
import type { PlaybackSnapshot } from "../src/spotify/types.js";

const playing: PlaybackSnapshot = {
  status: "playing",
  coverUrl: null,
  sampledAtUnixMs: 100_000,
  nowPlaying: {
    trackId: "track-1",
    title: "Song",
    artist: "Artist",
    isPlaying: true,
    durationMs: 180_000,
    progressMs: 20_000,
    sampledAtUnixMs: 100_000,
  },
};

test("auto selects Spotify only for a recent, confirmed playing snapshot", () => {
  assert.equal(resolveActiveScene({ mode: "auto", snapshot: playing, nowUnixMs: 120_000 }), "spotify");
  assert.equal(resolveActiveScene({ mode: "auto", snapshot: playing, nowUnixMs: 145_001 }), "gif");
  assert.equal(resolveActiveScene({ mode: "auto", snapshot: { ...playing, status: "paused" }, nowUnixMs: 120_000 }), "gif");
});

test("manual Spotify remains on its waiting screen when playback is idle or stale", () => {
  const idle: PlaybackSnapshot = { status: "idle", nowPlaying: null, coverUrl: null, sampledAtUnixMs: 100_000 };
  assert.equal(resolveActiveScene({ mode: "spotify", snapshot: idle, nowUnixMs: 200_000 }), "spotify");
  assert.equal(resolveActiveScene({ mode: "spotify", snapshot: playing, nowUnixMs: 200_000 }), "spotify");
});

test("manual GIF always selects the fullscreen animation scene", () => {
  assert.equal(resolveActiveScene({ mode: "gif", snapshot: playing, nowUnixMs: 120_000 }), "gif");
});
