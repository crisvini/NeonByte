import { createHash, randomBytes } from "node:crypto";
import {
  ReauthorizationRequiredError,
  SpotifyNetworkError,
  SpotifyOAuthError,
} from "./errors.js";
import type { AccessTokenProvider } from "./types.js";
import type { RefreshTokenStore } from "./token-store.js";

const AUTHORIZATION_ENDPOINT = "https://accounts.spotify.com/authorize";
const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";
const PLAYBACK_SCOPE = "user-read-currently-playing";
const DEFAULT_REFRESH_SKEW_MS = 60_000;
const DEFAULT_TOKEN_REQUEST_TIMEOUT_MS = 10_000;

class InvalidRefreshTokenResponseError extends SpotifyOAuthError {
  constructor() {
    super("Spotify refresh token is invalid.");
  }
}

interface SpotifyTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
}

export interface SpotifyOAuthClientOptions {
  clientId: string;
  redirectUri: string;
  tokenStore: RefreshTokenStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  refreshSkewMs?: number;
  tokenRequestTimeoutMs?: number;
}

export interface SpotifyAuthorizationRequest {
  url: string;
  state: string;
  codeVerifier: string;
}

interface AccessTokenState {
  value: string;
  expiresAt: number;
}

function validateRedirectUri(value: string): URL {
  let redirect: URL;
  try {
    redirect = new URL(value);
  } catch {
    throw new SpotifyOAuthError("SPOTIFY_REDIRECT_URI must be an HTTP callback on 127.0.0.1.");
  }

  if (
    redirect.protocol !== "http:" ||
    redirect.hostname !== "127.0.0.1" ||
    redirect.port.length === 0 ||
    Number(redirect.port) === 0 ||
    redirect.username.length > 0 ||
    redirect.password.length > 0 ||
    redirect.pathname !== "/callback" ||
    redirect.search.length > 0 ||
    redirect.hash.length > 0
  ) {
    throw new SpotifyOAuthError(
      "SPOTIFY_REDIRECT_URI must use http://127.0.0.1:<port>/callback, as required by current Spotify rules.",
    );
  }

  return redirect;
}

function parseTokenResponse(value: unknown): SpotifyTokenResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SpotifyOAuthError("Spotify returned an invalid authorization response.");
  }
  return value as SpotifyTokenResponse;
}

async function responseJson(response: Response): Promise<SpotifyTokenResponse> {
  try {
    return parseTokenResponse(await response.json());
  } catch (error) {
    if (error instanceof SpotifyOAuthError) {
      throw error;
    }
    throw new SpotifyOAuthError("Spotify returned an invalid authorization response.");
  }
}

export class SpotifyOAuthClient implements AccessTokenProvider {
  private readonly clientId: string;
  private readonly redirectUri: string;
  private readonly tokenStore: RefreshTokenStore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly refreshSkewMs: number;
  private readonly tokenRequestTimeoutMs: number;
  private accessToken: AccessTokenState | null = null;
  private refreshInFlight: Promise<string> | null = null;

  constructor(options: SpotifyOAuthClientOptions) {
    if (!options.clientId.trim()) {
      throw new SpotifyOAuthError("SPOTIFY_CLIENT_ID is required.");
    }

    validateRedirectUri(options.redirectUri);
    this.clientId = options.clientId.trim();
    this.redirectUri = options.redirectUri;
    this.tokenStore = options.tokenStore;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    this.tokenRequestTimeoutMs = options.tokenRequestTimeoutMs ?? DEFAULT_TOKEN_REQUEST_TIMEOUT_MS;
  }

  createAuthorizationRequest(): SpotifyAuthorizationRequest {
    const codeVerifier = randomBytes(64).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const state = randomBytes(32).toString("base64url");
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: PLAYBACK_SCOPE,
      state,
      code_challenge_method: "S256",
      code_challenge: codeChallenge,
    }).toString();

    return { url: url.toString(), state, codeVerifier };
  }

  async exchangeAuthorizationCode(input: { code: string; codeVerifier: string }): Promise<void> {
    const response = await this.requestToken({
      grant_type: "authorization_code",
      client_id: this.clientId,
      code: input.code,
      redirect_uri: this.redirectUri,
      code_verifier: input.codeVerifier,
    });

    if (typeof response.refresh_token !== "string" || response.refresh_token.length === 0) {
      throw new SpotifyOAuthError("Spotify did not provide a refresh token; authorize again.");
    }

    await this.tokenStore.set(response.refresh_token);
    this.rememberAccessToken(response);
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.accessToken && this.accessToken.expiresAt - this.refreshSkewMs > this.now()) {
      return this.accessToken.value;
    }

    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.refreshAccessToken();
    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  private async refreshAccessToken(): Promise<string> {
    const refreshToken = await this.tokenStore.get();
    if (!refreshToken) {
      throw new ReauthorizationRequiredError();
    }

    let response: SpotifyTokenResponse;
    try {
      response = await this.requestToken({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.clientId,
      });
    } catch (error) {
      if (error instanceof InvalidRefreshTokenResponseError) {
        await this.tokenStore.clear();
        this.accessToken = null;
        throw new ReauthorizationRequiredError();
      }
      throw error;
    }

    if (typeof response.refresh_token === "string" && response.refresh_token.length > 0) {
      await this.tokenStore.set(response.refresh_token);
    }
    return this.rememberAccessToken(response);
  }

  private async requestToken(parameters: Record<string, string>): Promise<SpotifyTokenResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(parameters),
        signal: AbortSignal.timeout(this.tokenRequestTimeoutMs),
      });
    } catch {
      throw new SpotifyNetworkError();
    }

    const payload = await responseJson(response);
    if (!response.ok) {
      if (parameters["grant_type"] === "refresh_token" && payload.error === "invalid_grant") {
        throw new InvalidRefreshTokenResponseError();
      }
      throw new SpotifyOAuthError("Spotify denied authorization. Check your settings and try again.");
    }
    return payload;
  }

  private rememberAccessToken(response: SpotifyTokenResponse): string {
    if (
      typeof response.access_token !== "string" ||
      response.access_token.length === 0 ||
      typeof response.expires_in !== "number" ||
      !Number.isFinite(response.expires_in) ||
      response.expires_in <= 0
    ) {
      throw new SpotifyOAuthError("Spotify returned an invalid authorization response.");
    }

    this.accessToken = {
      value: response.access_token,
      expiresAt: this.now() + Math.trunc(response.expires_in * 1000),
    };
    return this.accessToken.value;
  }
}
