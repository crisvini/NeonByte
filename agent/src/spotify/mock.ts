import type { CurrentPlaybackProvider, SpotifyCurrentPlayback } from "./types.js";

/** Mutable in-memory provider for local development and deterministic tests. */
export class MockSpotifyProvider implements CurrentPlaybackProvider {
  private playback: SpotifyCurrentPlayback | null;
  private failure: Error | null = null;
  calls = 0;

  constructor(initialPlayback: SpotifyCurrentPlayback | null = null) {
    this.playback = initialPlayback;
  }

  setPlayback(playback: SpotifyCurrentPlayback | null): void {
    this.playback = playback;
    this.failure = null;
  }

  setError(error: Error | null): void {
    this.failure = error;
  }

  async getCurrentPlayback(): Promise<SpotifyCurrentPlayback | null> {
    this.calls += 1;
    if (this.failure) {
      throw this.failure;
    }
    return this.playback;
  }
}
