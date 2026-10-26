export class SpotifyOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpotifyOAuthError";
  }
}

export class ReauthorizationRequiredError extends SpotifyOAuthError {
  constructor() {
    super("Spotify authorization expired or was revoked. Run the authorization command again.");
    this.name = "ReauthorizationRequiredError";
  }
}

export class CredentialStoreError extends Error {
  constructor() {
    super("Unable to access the system credential manager. Check Credential Manager or Secret Service.");
    this.name = "CredentialStoreError";
  }
}

export class SpotifyAuthenticationError extends Error {
  constructor() {
    super("Spotify rejected authentication. Authorize the account again.");
    this.name = "SpotifyAuthenticationError";
  }
}

export class SpotifyNetworkError extends Error {
  constructor() {
    super("Network failure while connecting to Spotify services.");
    this.name = "SpotifyNetworkError";
  }
}

export class SpotifyApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number) {
    super(`The Spotify Web API responded with HTTP ${statusCode}.`);
    this.name = "SpotifyApiError";
    this.statusCode = statusCode;
  }
}

export class RateLimitedError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("The Spotify Web API temporarily rate-limited requests.");
    this.name = "RateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class SpotifyResponseError extends Error {
  constructor() {
    super("The Spotify Web API returned an invalid response.");
    this.name = "SpotifyResponseError";
  }
}
