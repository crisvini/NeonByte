export interface SpotifyImage {
  url: string;
  width?: number | null;
  height?: number | null;
}

export interface SpotifyArtist {
  name?: string;
}

export interface SpotifyTrack {
  type?: string;
  id?: string | null;
  uri?: string;
  name?: string;
  duration_ms?: number;
  artists?: SpotifyArtist[];
  album?: {
    images?: SpotifyImage[];
  };
}

export interface SpotifyCurrentPlayback {
  is_playing?: boolean;
  progress_ms?: number | null;
  item?: SpotifyTrack | null;
}

export interface NowPlayingV1 {
  trackId: string;
  title: string;
  artist: string;
  isPlaying: boolean;
  durationMs: number;
  progressMs: number;
  sampledAtUnixMs: number;
}

export interface NormalizedPlayback {
  status: "playing" | "paused";
  nowPlaying: NowPlayingV1;
  coverUrl: string | null;
}

export type UnavailableReason =
  | "authentication_required"
  | "rate_limited"
  | "offline"
  | "api_error";

export interface PlaybackSnapshot {
  status: "playing" | "paused" | "idle" | "unavailable";
  nowPlaying: NowPlayingV1 | null;
  coverUrl: string | null;
  sampledAtUnixMs: number;
  unavailableReason?: UnavailableReason;
}

export interface CurrentPlaybackProvider {
  getCurrentPlayback(): Promise<SpotifyCurrentPlayback | null>;
}

export interface AccessTokenProvider {
  getAccessToken(forceRefresh?: boolean): Promise<string>;
}

export interface SafeLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const silentLogger: SafeLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
