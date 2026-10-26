import {
  RateLimitedError,
  SpotifyApiError,
  SpotifyAuthenticationError,
  SpotifyNetworkError,
  SpotifyResponseError,
} from "./errors.js";
import type {
  AccessTokenProvider,
  SpotifyCurrentPlayback,
} from "./types.js";

const CURRENTLY_PLAYING_ENDPOINT = "https://api.spotify.com/v1/me/player/currently-playing";

export interface SpotifyWebApiClientOptions {
  tokenProvider: AccessTokenProvider;
  fetchImpl?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
}

function retryAfterMs(response: Response, now: number): number {
  const value = response.headers.get("Retry-After");
  if (!value) {
    return 1000;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const retryAt = Date.parse(value);
  return Number.isNaN(retryAt) ? 1000 : Math.max(0, retryAt - now);
}

export class SpotifyWebApiClient {
  private readonly tokenProvider: AccessTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;

  constructor(options: SpotifyWebApiClientOptions) {
    this.tokenProvider = options.tokenProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  async getCurrentPlayback(): Promise<SpotifyCurrentPlayback | null> {
    let token = await this.tokenProvider.getAccessToken();
    let response = await this.requestPlayback(token);

    if (response.status === 401) {
      token = await this.tokenProvider.getAccessToken(true);
      response = await this.requestPlayback(token);
      if (response.status === 401) {
        throw new SpotifyAuthenticationError();
      }
    }

    if (response.status === 204) {
      return null;
    }
    if (response.status === 429) {
      throw new RateLimitedError(retryAfterMs(response, this.now()));
    }
    if (!response.ok) {
      throw new SpotifyApiError(response.status);
    }

    let playback: SpotifyCurrentPlayback;
    try {
      const payload: unknown = await response.json();
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new SpotifyResponseError();
      }
      playback = payload as SpotifyCurrentPlayback;
    } catch (error) {
      if (error instanceof SpotifyResponseError) {
        throw error;
      }
      throw new SpotifyResponseError();
    }
    return playback;
  }

  private async requestPlayback(accessToken: string): Promise<Response> {
    try {
      return await this.fetchImpl(CURRENTLY_PLAYING_ENDPOINT, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      throw new SpotifyNetworkError();
    }
  }
}
