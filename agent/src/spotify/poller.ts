import { RateLimitedError, ReauthorizationRequiredError, SpotifyAuthenticationError } from "./errors.js";
import { normalizeSpotifyPlayback } from "./normalize.js";
import type {
  CurrentPlaybackProvider,
  NowPlayingV1,
  PlaybackSnapshot,
  SafeLogger,
  UnavailableReason,
} from "./types.js";
import { silentLogger } from "./types.js";

interface TrackMetadata {
  title: string;
  artist: string;
  durationMs: number;
  coverUrl: string | null;
}

export interface PlaybackPollerOptions {
  provider: CurrentPlaybackProvider;
  pollIntervalMs: number;
  maxReconnectDelayMs?: number;
  now?: () => number;
  logger?: SafeLogger;
}

const initialSnapshot: PlaybackSnapshot = {
  status: "idle",
  nowPlaying: null,
  coverUrl: null,
  sampledAtUnixMs: 0,
};

function samePlayback(left: PlaybackSnapshot, right: PlaybackSnapshot): boolean {
  if (left.status !== right.status || left.coverUrl !== right.coverUrl || left.unavailableReason !== right.unavailableReason) {
    return false;
  }
  if (left.nowPlaying === null || right.nowPlaying === null) {
    return left.nowPlaying === right.nowPlaying;
  }

  const leftTrack: NowPlayingV1 = left.nowPlaying;
  const rightTrack: NowPlayingV1 = right.nowPlaying;
  return leftTrack.trackId === rightTrack.trackId &&
    leftTrack.title === rightTrack.title &&
    leftTrack.artist === rightTrack.artist &&
    leftTrack.isPlaying === rightTrack.isPlaying &&
    leftTrack.durationMs === rightTrack.durationMs &&
    leftTrack.progressMs === rightTrack.progressMs;
}

function unavailableReason(error: unknown): UnavailableReason {
  if (error instanceof ReauthorizationRequiredError || error instanceof SpotifyAuthenticationError) {
    return "authentication_required";
  }
  if (error instanceof RateLimitedError) {
    return "rate_limited";
  }
  if (error instanceof TypeError || (error instanceof Error && /network|fetch|timeout/i.test(error.name + error.message))) {
    return "offline";
  }
  return "api_error";
}

export class PlaybackPoller {
  private readonly provider: CurrentPlaybackProvider;
  private readonly pollIntervalMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly now: () => number;
  private readonly logger: SafeLogger;
  private readonly listeners = new Set<(snapshot: PlaybackSnapshot) => void>();
  private readonly metadataCache = new Map<string, TrackMetadata>();
  private snapshot: PlaybackSnapshot = initialSnapshot;
  private failureCount = 0;
  private retryAfterMs: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private polling = false;

  constructor(options: PlaybackPollerOptions) {
    if (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs < 1000) {
      throw new RangeError("O intervalo de polling deve ser de pelo menos 1000 ms.");
    }
    this.provider = options.provider;
    this.pollIntervalMs = Math.trunc(options.pollIntervalMs);
    this.maxReconnectDelayMs = Math.max(1000, Math.trunc(options.maxReconnectDelayMs ?? 60_000));
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
  }

  get currentSnapshot(): PlaybackSnapshot {
    return this.snapshot;
  }

  get cachedTrackCount(): number {
    return this.metadataCache.size;
  }

  get nextDelayMs(): number {
    if (this.retryAfterMs !== null) {
      return Math.max(this.pollIntervalMs, this.retryAfterMs);
    }
    if (this.failureCount === 0) {
      return this.pollIntervalMs;
    }
    return Math.min(this.maxReconnectDelayMs, 2000 * (2 ** (this.failureCount - 1)));
  }

  subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async pollOnce(): Promise<PlaybackSnapshot> {
    if (this.polling) {
      return this.snapshot;
    }

    this.polling = true;
    try {
      const playback = await this.provider.getCurrentPlayback();
      const normalized = normalizeSpotifyPlayback(playback, this.now());
      this.failureCount = 0;
      this.retryAfterMs = null;

      const next = normalized
        ? this.withCachedMetadata(normalized)
        : {
            status: "idle" as const,
            nowPlaying: null,
            coverUrl: null,
            sampledAtUnixMs: this.now(),
          };
      this.publish(next);
    } catch (error) {
      if (error instanceof RateLimitedError) {
        this.retryAfterMs = error.retryAfterMs;
      } else {
        this.failureCount += 1;
        this.retryAfterMs = null;
      }
      this.publish({
        status: "unavailable",
        nowPlaying: null,
        coverUrl: null,
        sampledAtUnixMs: this.now(),
        unavailableReason: unavailableReason(error),
      });
      this.logger.warn(error instanceof RateLimitedError
        ? "Spotify limitou as consultas; o agente aguardará antes de tentar novamente."
        : "Consulta Spotify indisponível; o agente tentará reconectar.");
    } finally {
      this.polling = false;
    }

    return this.snapshot;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.pollAndSchedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async pollAndSchedule(): Promise<void> {
    if (!this.running) {
      return;
    }
    await this.pollOnce();
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollAndSchedule();
    }, this.nextDelayMs);
  }

  private withCachedMetadata(normalized: NonNullable<ReturnType<typeof normalizeSpotifyPlayback>>): PlaybackSnapshot {
    const key = normalized.nowPlaying.trackId;
    const existing = this.metadataCache.get(key);
    const metadata = existing ?? {
      title: normalized.nowPlaying.title,
      artist: normalized.nowPlaying.artist,
      durationMs: normalized.nowPlaying.durationMs,
      coverUrl: normalized.coverUrl,
    };
    this.metadataCache.delete(key);
    this.metadataCache.set(key, metadata);
    while (this.metadataCache.size > 100) {
      const oldest = this.metadataCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.metadataCache.delete(oldest);
    }

    return {
      status: normalized.status,
      coverUrl: metadata.coverUrl,
      sampledAtUnixMs: normalized.nowPlaying.sampledAtUnixMs,
      nowPlaying: {
        ...normalized.nowPlaying,
        title: metadata.title,
        artist: metadata.artist,
        durationMs: metadata.durationMs,
      },
    };
  }

  private publish(next: PlaybackSnapshot): void {
    if (samePlayback(this.snapshot, next)) {
      this.snapshot = next;
      return;
    }

    this.snapshot = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        this.logger.error("Um consumidor local falhou ao receber o estado Spotify.");
      }
    }
  }
}
