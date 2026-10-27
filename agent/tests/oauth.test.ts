import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SpotifyOAuthClient } from "../src/spotify/oauth.js";
import { startOAuthCallbackServer } from "../src/spotify/oauth-callback.js";
import type { RefreshTokenStore } from "../src/spotify/token-store.js";

class MemoryTokenStore implements RefreshTokenStore {
  value: string | null = null;
  writes: string[] = [];
  clears = 0;

  async get(): Promise<string | null> {
    return this.value;
  }

  async set(token: string): Promise<void> {
    this.value = token;
    this.writes.push(token);
  }

  async clear(): Promise<void> {
    this.value = null;
    this.clears += 1;
  }
}

function tokenResponse(accessToken: string, refreshToken: string | undefined, expiresIn = 3600): Response {
  return new Response(JSON.stringify({
    access_token: accessToken,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    expires_in: expiresIn,
    token_type: "Bearer",
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("builds a PKCE authorization request with only the minimum playback scope", () => {
  const oauth = new SpotifyOAuthClient({
    clientId: "client-id",
    redirectUri: "http://127.0.0.1:8787/callback",
    tokenStore: new MemoryTokenStore(),
  });

  const request = oauth.createAuthorizationRequest();
  const url = new URL(request.url);
  const expectedChallenge = createHash("sha256")
    .update(request.codeVerifier)
    .digest("base64url");

  assert.equal(url.origin, "https://accounts.spotify.com");
  assert.equal(url.pathname, "/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:8787/callback");
  assert.equal(url.searchParams.get("scope"), "user-read-currently-playing");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), expectedChallenge);
  assert.equal(url.searchParams.get("state"), request.state);
  assert.equal(url.searchParams.has("code_verifier"), false);
  assert.ok(request.codeVerifier.length >= 43 && request.codeVerifier.length <= 128);
});

test("exchanges an authorization code and persists only the refresh token", async () => {
  const store = new MemoryTokenStore();
  let receivedBody = "";
  const oauth = new SpotifyOAuthClient({
    clientId: "client-id",
    redirectUri: "http://127.0.0.1:8787/callback",
    tokenStore: store,
    fetchImpl: async (_input, init) => {
      receivedBody = String(init?.body);
      return tokenResponse("access-secret", "refresh-secret");
    },
  });
  const request = oauth.createAuthorizationRequest();

  await oauth.exchangeAuthorizationCode({
    code: "authorization-code",
    codeVerifier: request.codeVerifier,
  });

  assert.equal(store.value, "refresh-secret");
  assert.equal(store.writes.length, 1);
  assert.equal(await oauth.getAccessToken(), "access-secret");
  const body = new URLSearchParams(receivedBody);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("client_id"), "client-id");
  assert.equal(body.get("code"), "authorization-code");
  assert.equal(body.get("redirect_uri"), "http://127.0.0.1:8787/callback");
  assert.equal(body.get("code_verifier"), request.codeVerifier);
});

test("refreshes before expiry and retains the old refresh token if Spotify omits rotation", async () => {
  const store = new MemoryTokenStore();
  store.value = "refresh-old";
  let now = 1000;
  let tokenRequests = 0;
  let refreshBody: URLSearchParams | undefined;
  const oauth = new SpotifyOAuthClient({
    clientId: "client-id",
    redirectUri: "http://127.0.0.1:8787/callback",
    tokenStore: store,
    now: () => now,
    fetchImpl: async (_input, init) => {
      tokenRequests += 1;
      refreshBody = new URLSearchParams(String(init?.body));
      return tokenResponse("access-next", undefined, 3600);
    },
  });

  now += 3_550_000;
  assert.equal(await oauth.getAccessToken(), "access-next");
  assert.equal(tokenRequests, 1);
  assert.equal(refreshBody?.get("grant_type"), "refresh_token");
  assert.equal(refreshBody?.get("refresh_token"), "refresh-old");
  assert.equal(refreshBody?.get("client_id"), "client-id");
  assert.equal(store.value, "refresh-old");
});

test("persists a rotated refresh token and coalesces concurrent refresh requests", async () => {
  const store = new MemoryTokenStore();
  store.value = "refresh-before";
  let requests = 0;
  let releaseRequest: ((response: Response) => void) | undefined;
  const oauth = new SpotifyOAuthClient({
    clientId: "client-id",
    redirectUri: "http://127.0.0.1:8787/callback",
    tokenStore: store,
    fetchImpl: async () => {
      requests += 1;
      return await new Promise<Response>((resolve) => { releaseRequest = resolve; });
    },
  });

  const first = oauth.getAccessToken();
  const second = oauth.getAccessToken();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  releaseRequest?.(tokenResponse("access-after", "refresh-after"));
  assert.deepEqual(await Promise.all([first, second]), ["access-after", "access-after"]);
  assert.equal(store.value, "refresh-after");
});

test("clears an expired or revoked refresh token and requires authorization again", async () => {
  const store = new MemoryTokenStore();
  store.value = "refresh-invalid";
  const oauth = new SpotifyOAuthClient({
    clientId: "client-id",
    redirectUri: "http://127.0.0.1:8787/callback",
    tokenStore: store,
    fetchImpl: async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
  });

  await assert.rejects(oauth.getAccessToken(), /authorization command again/i);
  assert.equal(store.value, null);
  assert.equal(store.clears, 1);
});

test("rejects non-loopback callback URLs before opening an OAuth flow", () => {
  assert.throws(() => new SpotifyOAuthClient({
    clientId: "client-id",
    redirectUri: "http://localhost:8787/callback",
    tokenStore: new MemoryTokenStore(),
  }), /127\.0\.0\.1/);
  assert.throws(() => new SpotifyOAuthClient({
    clientId: "client-id",
    redirectUri: "http://127.0.0.1:0/callback",
    tokenStore: new MemoryTokenStore(),
  }), /port/i);
});

test("receives the authorization code through a loopback callback and rejects a wrong state", async () => {
  const listener = await startOAuthCallbackServer({
    redirectUri: "http://127.0.0.1:0/callback",
    expectedState: "expected-state",
    timeoutMs: 1000,
  });
  try {
    const callbackUrl = new URL(listener.redirectUri);
    callbackUrl.search = new URLSearchParams({ code: "short-lived-code", state: "expected-state" }).toString();
    const response = await fetch(callbackUrl);
    assert.equal(response.status, 200);
    assert.deepEqual(await listener.waitForCallback(), { code: "short-lived-code" });

    const secondListener = await startOAuthCallbackServer({
      redirectUri: "http://127.0.0.1:0/callback",
      expectedState: "expected-state",
      timeoutMs: 1000,
    });
    try {
      const rejectedCallback = secondListener.waitForCallback();
      const badCallback = new URL(secondListener.redirectUri);
      badCallback.search = new URLSearchParams({ code: "must-not-be-accepted", state: "wrong-state" }).toString();
      assert.equal((await fetch(badCallback)).status, 400);
      await assert.rejects(rejectedCallback, /state validation/i);
    } finally {
      await secondListener.close();
    }
  } finally {
    await listener.close();
  }
});

test("a new OAuth client reconnects using the refresh token saved by an earlier client", async () => {
  const store = new MemoryTokenStore();
  const options = { clientId: "client-id", redirectUri: "http://127.0.0.1:8787/callback", tokenStore: store };
  const first = new SpotifyOAuthClient({ ...options, fetchImpl: async () => tokenResponse("first-access", "saved-refresh") });
  const request = first.createAuthorizationRequest();
  await first.exchangeAuthorizationCode({ code: "code", codeVerifier: request.codeVerifier });
  let refreshToken: string | null = null;
  const restarted = new SpotifyOAuthClient({ ...options, fetchImpl: async (_input, init) => {
    refreshToken = new URLSearchParams(String(init?.body)).get("refresh_token");
    return tokenResponse("reconnected-access", undefined);
  } });
  assert.equal(await restarted.getAccessToken(), "reconnected-access");
  assert.equal(refreshToken, "saved-refresh");
});
