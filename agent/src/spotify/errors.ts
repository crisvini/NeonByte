export class SpotifyOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpotifyOAuthError";
  }
}

export class ReauthorizationRequiredError extends SpotifyOAuthError {
  constructor() {
    super("A autorização Spotify expirou ou foi revogada. Execute o comando de autorização novamente.");
    this.name = "ReauthorizationRequiredError";
  }
}

export class CredentialStoreError extends Error {
  constructor() {
    super("Não foi possível acessar o cofre seguro do sistema. Verifique o Credential Manager ou Secret Service.");
    this.name = "CredentialStoreError";
  }
}

export class SpotifyAuthenticationError extends Error {
  constructor() {
    super("Spotify recusou a autenticação. Autorize a conta novamente.");
    this.name = "SpotifyAuthenticationError";
  }
}

export class SpotifyNetworkError extends Error {
  constructor() {
    super("Falha de rede ao conectar com os serviços Spotify.");
    this.name = "SpotifyNetworkError";
  }
}

export class SpotifyApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number) {
    super(`A Spotify Web API respondeu com HTTP ${statusCode}.`);
    this.name = "SpotifyApiError";
    this.statusCode = statusCode;
  }
}

export class RateLimitedError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("A Spotify Web API limitou temporariamente as consultas.");
    this.name = "RateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class SpotifyResponseError extends Error {
  constructor() {
    super("A Spotify Web API retornou uma resposta inválida.");
    this.name = "SpotifyResponseError";
  }
}
