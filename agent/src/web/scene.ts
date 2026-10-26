import type { PlaybackSnapshot } from "../spotify/types.js";

export type DisplayMode = "auto" | "spotify" | "gif";
export type DisplayScene = "spotify" | "gif";

export interface SceneResolutionInput {
  mode: DisplayMode;
  snapshot: PlaybackSnapshot;
  nowUnixMs: number;
  timeoutMs?: number;
}

export function resolveActiveScene({ mode, snapshot, nowUnixMs, timeoutMs = 45_000 }: SceneResolutionInput): DisplayScene {
  if (mode === "gif") {
    return "gif";
  }
  if (mode === "spotify") {
    return "spotify";
  }
  const recent = snapshot.sampledAtUnixMs > 0 && nowUnixMs - snapshot.sampledAtUnixMs <= timeoutMs;
  return recent && snapshot.status === "playing" && snapshot.nowPlaying?.isPlaying === true ? "spotify" : "gif";
}
