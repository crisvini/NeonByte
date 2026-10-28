import assert from "node:assert/strict";
import test from "node:test";
import { DeviceClient, DeviceSynchronizer } from "../src/device/client.js";
import { createCoverAsset } from "../src/media/animation.js";
import { MockSpotifyProvider } from "../src/spotify/mock.js";
import { PlaybackPoller } from "../src/spotify/poller.js";

const art = createCoverAsset(Uint8Array.from([255, 0, 0, 255]), 1, 1);
const playback = (id: string) => ({ is_playing: true, progress_ms: 1000,
  item: { type: "track", id, name: id, duration_ms: 180000, artists: [{ name: "Artist" }],
    album: { images: [{ url: `https://i.scdn.co/${id}` }] } } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(upload?: () => Promise<void>) {
  const requests: Array<{ path: string; body?: string; track?: string }> = [];
  let active = 0, maxActive = 0;
  const client = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token: "test-secret", fetchDevice: async (input, init) => {
    active++; maxActive = Math.max(maxActive, active);
    const path = new URL(String(input)).pathname;
    requests.push({ path, ...(typeof init?.body === "string" ? { body: init.body } : {}),
      ...(path.endsWith("/cover") ? { track: new Headers(init?.headers).get("X-Track-Id")! } : {}) });
    try {
      if (init?.method === "GET") return new Response(JSON.stringify({ protocolVersion: "v1", firmwareVersion: "host",
        ip: "127.0.0.1", freeStorageBytes: 4000000, mode: "auto", activeScene: "spotify" }));
      if (path.endsWith("/cover")) await upload?.();
      return new Response(null, { status: 204 });
    } finally { active--; }
  } });
  const provider = new MockSpotifyProvider(playback("first"));
  const poller = new PlaybackPoller({ provider, pollIntervalMs: 15000, now: () => 1790000000000 });
  return { client, provider, poller, requests, get maxActive() { return maxActive; } };
}

test("slow cover preparation does not hold metadata or heartbeat and obsolete artwork is discarded", async (t) => {
  const f = fixture();
  const loading = deferred<typeof art>();
  t.after(() => loading.resolve(art));
  let loads = 0;
  const sync = new DeviceSynchronizer({ client: f.client, poller: f.poller, loadCover: async () => {
    loads++; return loads === 1 ? loading.promise : art;
  } });
  await f.poller.pollOnce();
  const first = sync.synchronize();
  const result = await Promise.race([first, new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100))]);
  assert.equal(result, true);
  f.provider.setPlayback(playback("second")); await f.poller.pollOnce();
  await sync.synchronize();
  assert.equal(f.requests.filter(({ path }) => path.endsWith("/heartbeat")).length, 2);
  assert.equal(f.requests.filter(({ path }) => path.endsWith("/cover")).length, 0);
  loading.resolve(art);
  await first;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await sync.synchronize();
  assert.deepEqual(f.requests.filter(({ path }) => path.endsWith("/cover")).map(({ track }) => track), ["second"]);
  assert.equal(f.maxActive, 1);
});

for (const failUpload of [false, true]) {
  test(`cover upload ${failUpload ? "failure" : "completion"} refreshes the latest playback and heartbeat sequentially`, async () => {
    const uploading = deferred<void>(), release = deferred<void>();
    const f = fixture(async () => { uploading.resolve(); await release.promise; if (failUpload) throw new Error("offline"); });
    const sync = new DeviceSynchronizer({ client: f.client, poller: f.poller, loadCover: async () => art });
    await f.poller.pollOnce();
    const operation = sync.synchronize();
    await uploading.promise;
    f.provider.setPlayback(playback("second")); await f.poller.pollOnce();
    release.resolve();
    assert.equal(await operation, true);
    const coverIndex = f.requests.findIndex(({ path }) => path.endsWith("/cover"));
    const after = f.requests.slice(coverIndex + 1);
    assert.equal(JSON.parse(after.find(({ path }) => path.endsWith("/spotify"))!.body!).trackId, "second");
    assert.ok(after.some(({ path }) => path.endsWith("/heartbeat")));
    assert.equal(f.maxActive, 1);
  });
}

test("cover decoding failure leaves the transport healthy and retries without suppressing heartbeats", async () => {
  const f = fixture();
  let failed = true;
  const sync = new DeviceSynchronizer({ client: f.client, poller: f.poller, loadCover: async () => {
    if (failed) throw new Error("decoder failed"); return art;
  } });
  await f.poller.pollOnce();
  assert.equal(await sync.synchronize(), true);
  failed = false;
  assert.equal(await sync.synchronize(), true);
  assert.equal(f.requests.filter(({ path }) => path.endsWith("/cover")).length, 1);
  assert.equal(f.maxActive, 1);
});
