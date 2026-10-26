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
    throw new SpotifyOAuthError("The OAuth callback must use 127.0.0.1.");
  }

  if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" || redirect.pathname !== "/callback") {
    throw new SpotifyOAuthError("The OAuth callback must use http://127.0.0.1:<port>/callback.");
  }
  return redirect;
}

function sameState(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function parseOAuthCallback(url: URL, expectedState: string): OAuthCallbackResult {
  const state = url.searchParams.get("state") ?? "";
  if (!sameState(expectedState, state)) {
    throw new SpotifyOAuthError("The OAuth response failed state validation. Start a new authorization.");
  }

  const providerError = url.searchParams.get("error");
  if (providerError) {
    throw new SpotifyOAuthError("Spotify authorization was canceled or denied.");
  }

  const code = url.searchParams.get("code");
  if (!code) {
    throw new SpotifyOAuthError("Spotify did not return an authorization code.");
  }
  return { code };
}

export async function startOAuthCallbackServer(options: OAuthCallbackOptions): Promise<OAuthCallbackListener> {
  const redirect = validateLoopbackUri(options.redirectUri);
  const configuredPort = Number(redirect.port);
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) {
    throw new SpotifyOAuthError("The OAuth callback port is invalid.");
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
      response.writeHead(400).end("Invalid callback.");
      return;
    }

    if (request.method !== "GET" || incoming.pathname !== redirect.pathname) {
      response.writeHead(404).end("Route not found.");
      return;
    }

    try {
      const result = parseOAuthCallback(incoming, options.expectedState);
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
        .end("Authorization complete. You can close this window.");
      finish(result);
    } catch (error) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
        .end("Unable to complete authorization. Start the flow again.");
      finish(undefined, error instanceof Error ? error : new SpotifyOAuthError("OAuth callback failed."));
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", () => reject(new SpotifyOAuthError("Unable to open the local callback on 127.0.0.1.")));
      server.listen(configuredPort, "127.0.0.1", () => resolve());
    });
  } catch (error) {
    server.close();
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new SpotifyOAuthError("Unable to start the local callback.");
  }

  const listenerRedirect = new URL(redirect.toString());
  listenerRedirect.port = String(address.port);
  timeout = setTimeout(() => {
    finish(undefined, new SpotifyOAuthError("Timed out while waiting for Spotify authorization."));
  }, options.timeoutMs ?? 5 * 60_000);

  return {
    redirectUri: listenerRedirect.toString(),
    waitForCallback: () => resultPromise,
    close: async () => {
      if (!settled) {
        finish(undefined, new SpotifyOAuthError("The OAuth callback was closed."));
      }
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}
