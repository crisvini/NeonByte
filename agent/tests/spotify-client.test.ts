import assert from "node:assert/strict";
import test from "node:test";
import { RateLimitedError, SpotifyApiError } from "../src/spotify/errors.js";
import { SpotifyWebApiClient } from "../src/spotify/spotify-client.js";
import type { AccessTokenProvider } from "../src/spotify/types.js";

class FakeTokens implements AccessTokenProvider {
  forceRefreshCalls = 0;
  calls = 0;

  async getAccessToken(forceRefresh = false): Promise<string> {
    this.calls += 1;
    if (forceRefresh) {
      this.forceRefreshCalls += 1;
      return "refreshed-access-token";
    }
    return "access-token";
  }
}

const playback = {
  is_playing: true,
  progress_ms: 42_000,
  item: {
    type: "track",
    id: "track-1",
    name: "Song",
    duration_ms: 180_000,
    artists: [{ name: "Artist" }],
    album: { images: [{ url: "https://images.example/cover.jpg", width: 300, height: 300 }] },
  },
};

test("reads current playback and maps Spotify metadata to the v1 state", async () => {
  const tokens = new FakeTokens();
  let requestUrl = "";
  let authorization = "";
  const client = new SpotifyWebApiClient({
    tokenProvider: tokens,
    now: () => 1_790_000_000_000,
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json(playback);
    },
  });

  const current = await client.getCurrentPlayback();

  assert.equal(requestUrl, "https://api.spotify.com/v1/me/player/currently-playing");
  assert.equal(authorization, "Bearer access-token");
  assert.equal(current?.item?.id, "track-1");
  assert.equal(current?.progress_ms, 42_000);
  assert.equal(current?.item?.album?.images?.[0]?.url, "https://images.example/cover.jpg");
});

test("treats 204 as no currently playing track", async () => {
  const client = new SpotifyWebApiClient({
    tokenProvider: new FakeTokens(),
    fetchImpl: async () => new Response(null, { status: 204 }),
  });

  assert.equal(await client.getCurrentPlayback(), null);
});

test("refreshes once after 401 and retries the current playback request", async () => {
  const tokens = new FakeTokens();
  const authorizations: string[] = [];
  let requests = 0;
  const client = new SpotifyWebApiClient({
    tokenProvider: tokens,
    fetchImpl: async (_input, init) => {
      requests += 1;
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      return requests === 1
        ? new Response(null, { status: 401 })
        : Response.json(playback);
    },
  });

  assert.equal((await client.getCurrentPlayback())?.item?.id, "track-1");
  assert.equal(requests, 2);
  assert.deepEqual(authorizations, ["Bearer access-token", "Bearer refreshed-access-token"]);
  assert.equal(tokens.forceRefreshCalls, 1);
});

test("surfaces 429 Retry-After as a bounded retry delay without exposing response data", async () => {
  const client = new SpotifyWebApiClient({
    tokenProvider: new FakeTokens(),
    fetchImpl: async () => new Response("secret-looking-response-body", {
      status: 429,
      headers: { "Retry-After": "12" },
    }),
  });

  await assert.rejects(client.getCurrentPlayback(), (error: unknown) => {
    assert.ok(error instanceof RateLimitedError);
    assert.equal(error.retryAfterMs, 12_000);
    assert.equal(error.message.includes("secret-looking-response-body"), false);
    return true;
  });
});

test("treats network failures and other API failures as safe typed errors", async () => {
  const networkClient = new SpotifyWebApiClient({
    tokenProvider: new FakeTokens(),
    fetchImpl: async () => { throw new Error("sensitive transport detail"); },
  });
  await assert.rejects(networkClient.getCurrentPlayback(), /network/i);

  const apiClient = new SpotifyWebApiClient({
    tokenProvider: new FakeTokens(),
    fetchImpl: async () => new Response("secret-response", { status: 503 }),
  });
  await assert.rejects(apiClient.getCurrentPlayback(), (error: unknown) => {
    assert.ok(error instanceof SpotifyApiError);
    assert.equal(error.message.includes("secret-response"), false);
    return true;
  });
});
