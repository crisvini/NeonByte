import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { SpotifyOAuthError } from "./errors.js";

export interface OAuthCallbackResult {
  code: string;
}

export interface OAuthCallbackListener {
  redirectUri: string;
  waitForCallback(): Promise<OAuthCallbackResult>;
  close(): Promise<void>;
}

export interface OAuthCallbackOptions {
  redirectUri: string;
  expectedState: string;
  timeoutMs?: number;
}

function validateLoopbackUri(value: string): URL {
  let redirect: URL;
  try {
    redirect = new URL(value);
  } catch {
    throw new SpotifyOAuthError("O callback OAuth precisa usar 127.0.0.1.");
  }

  if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" || redirect.pathname !== "/callback") {
    throw new SpotifyOAuthError("O callback OAuth precisa usar http://127.0.0.1:<porta>/callback.");
  }
  return redirect;
}

function sameState(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function callbackResult(url: URL, expectedState: string): OAuthCallbackResult {
  const state = url.searchParams.get("state") ?? "";
  if (!sameState(expectedState, state)) {
    throw new SpotifyOAuthError("A resposta OAuth não passou na validação de estado. Inicie uma nova autorização.");
  }

  const providerError = url.searchParams.get("error");
  if (providerError) {
    throw new SpotifyOAuthError("A autorização Spotify foi cancelada ou recusada.");
  }

  const code = url.searchParams.get("code");
  if (!code) {
    throw new SpotifyOAuthError("Spotify não retornou um código de autorização.");
  }
  return { code };
}

export async function startOAuthCallbackServer(options: OAuthCallbackOptions): Promise<OAuthCallbackListener> {
  const redirect = validateLoopbackUri(options.redirectUri);
  const configuredPort = Number(redirect.port);
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) {
    throw new SpotifyOAuthError("A porta do callback OAuth é inválida.");
  }

  let resolveResult: (result: OAuthCallbackResult) => void = () => undefined;
  let rejectResult: (error: Error) => void = () => undefined;
  let settled = false;
  let timeout: NodeJS.Timeout | undefined;
  const resultPromise = new Promise<OAuthCallbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // Mark early callback failures as handled while callers finish presenting the authorization URL.
  void resultPromise.catch(() => undefined);

  const finish = (result?: OAuthCallbackResult, error?: Error) => {
    if (settled) {
      return;
    }
    settled = true;
    if (timeout) {
      clearTimeout(timeout);
    }
    if (error) {
      rejectResult(error);
    } else if (result) {
      resolveResult(result);
    }
  };

  const server: Server = createServer((request, response) => {
    let incoming: URL;
    try {
      incoming = new URL(request.url ?? "/", redirect.origin);
    } catch {
      response.writeHead(400).end("Callback inválido.");
      return;
    }

    if (request.method !== "GET" || incoming.pathname !== redirect.pathname) {
      response.writeHead(404).end("Rota não encontrada.");
      return;
    }

    try {
      const result = callbackResult(incoming, options.expectedState);
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
        .end("Autorização concluída. Você pode fechar esta janela.");
      finish(result);
    } catch (error) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
        .end("Não foi possível concluir a autorização. Inicie o fluxo novamente.");
      finish(undefined, error instanceof Error ? error : new SpotifyOAuthError("Falha no callback OAuth."));
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", () => reject(new SpotifyOAuthError("Não foi possível abrir o callback local em 127.0.0.1.")));
      server.listen(configuredPort, "127.0.0.1", () => resolve());
    });
  } catch (error) {
    server.close();
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new SpotifyOAuthError("Não foi possível iniciar o callback local.");
  }

  const listenerRedirect = new URL(redirect.toString());
  listenerRedirect.port = String(address.port);
  timeout = setTimeout(() => {
    finish(undefined, new SpotifyOAuthError("Tempo esgotado aguardando autorização Spotify."));
  }, options.timeoutMs ?? 5 * 60_000);

  return {
    redirectUri: listenerRedirect.toString(),
    waitForCallback: () => resultPromise,
    close: async () => {
      if (!settled) {
        finish(undefined, new SpotifyOAuthError("O callback OAuth foi encerrado."));
      }
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}
