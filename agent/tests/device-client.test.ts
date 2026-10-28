import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { DeviceClient } from "../src/device/client.js";
import { convertGifToAnimation } from "../src/media/animation.js";
import type { PlaybackSnapshot } from "../src/spotify/types.js";

const status = { protocolVersion: "v1", firmwareVersion: "host", ip: "127.0.0.1", freeStorageBytes: 4_000_000, mode: "auto", activeScene: "gif" };

test("temporary Spotify failures send no false pause while confirmed idle and pause still clear playback", async () => {
  const payloads: unknown[] = [];
  const client = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token: "test-secret",
    fetchDevice: async (input, init) => {
      if (init?.method === "GET") return new Response(JSON.stringify(status));
      if (String(input).endsWith("/spotify")) payloads.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    } });
  const snapshot: PlaybackSnapshot = { status: "playing", coverUrl: null, sampledAtUnixMs: 1000,
    nowPlaying: { trackId: "first", title: "First", artist: "Artist", isPlaying: true,
      durationMs: 180000, progressMs: 1000, sampledAtUnixMs: 1000 } };
  await client.sendPlayback(snapshot);
  for (const unavailableReason of ["offline", "api_error", "rate_limited", "authentication_required"] as const) {
    await client.sendPlayback({ status: "unavailable", nowPlaying: null, coverUrl: null, sampledAtUnixMs: 2000, unavailableReason });
  }
  assert.equal(payloads.length, 1);
  await client.sendPlayback({ ...snapshot, status: "paused", nowPlaying: { ...snapshot.nowPlaying!, isPlaying: false } });
  assert.equal((payloads.at(-1) as { isPlaying: boolean }).isPlaying, false);
  await client.sendPlayback({ status: "idle", nowPlaying: null, coverUrl: null, sampledAtUnixMs: 3000 });
  assert.deepEqual(payloads.at(-1), { ...snapshot.nowPlaying, isPlaying: false, sampledAtUnixMs: 3000 });
});

test("device mutations stop on incompatible or malformed status before disclosing pairing credentials", async () => {
  for (const invalid of [{ ...status, protocolVersion: "v2" }, { ...status, freeStorageBytes: -1 }, { ...status, extra: true }, { ...status, mode: "unknown" },
    { ...status, mode: ["gif"] }, { ...status, activeScene: ["gif"] },
    { ...status, ip: "x".repeat(65) }, { ...status, firmwareVersion: "x".repeat(65) }]) {
    const requests: RequestInit[] = [];
    const client = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token: "public-test-pairing", fetchDevice: async (_input, init) => {
      requests.push(init!); return new Response(JSON.stringify(invalid));
    } });
    await assert.rejects(client.heartbeat(), /compatible protocol v1/);
    assert.equal(requests.length, 1);
    assert.equal(new Headers(requests[0]!.headers).has("Authorization"), false);
  }
});

test("device request deadlines and rejected remote responses produce safe errors", async () => {
  const token = "public-test-secret-placeholder";
  const deadline = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token, timeoutMs: 10,
    fetchDevice: async (_input, init) => {
      assert.equal(init?.redirect, "error");
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error(token)), { once: true });
        // Keep this deterministic test alive while AbortSignal's unreferenced deadline fires.
        const timer = setTimeout(() => reject(new Error("Deadline failed to abort.")), 500);
        init?.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
      });
    } });
  await assert.rejects(deadline.status(), (error: Error) => !error.message.includes(token) && /compatible/.test(error.message));
  const rejected = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token,
    fetchDevice: async (_input, init) => init?.method === "GET" ? new Response(JSON.stringify(status)) : new Response(token, { status: 401 }) });
  await assert.rejects(rejected.heartbeat(), (error: Error) => !error.message.includes(token) && /communication failed/.test(error.message));
});

test("device client rejects public and hostname destinations before sending credentials", () => {
  for (const address of ["http://example.com", "http://8.8.8.8", "http://169.254.169.254", "http://[::ffff:8.8.8.8]", "http://192.168.1.1.example.com"]) {
    assert.throws(() => new DeviceClient({ baseUrl: address, token: "test-secret" }), /local|private/i);
  }
  for (const address of ["http://127.0.0.1:1", "http://10.1.2.3", "http://172.16.0.1", "http://192.168.1.2", "http://[::1]"]) {
    assert.doesNotThrow(() => new DeviceClient({ baseUrl: address, token: "test-secret" }));
  }
});

test("device deadlines scale for validated binary uploads and respect explicit overrides", async (context) => {
  const deadlines: number[] = [];
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    deadlines.push(milliseconds);
    return new AbortController().signal;
  });
  const makeAsset = (frames: number) => {
    const bytes = Buffer.alloc(frames === 0 ? 115_209 : 11 + frames * 115_202);
    bytes.write(frames === 0 ? "NBIC" : "NBIF");
    bytes.writeUInt8(1, 4);
    bytes.writeUInt16LE(240, 5);
    bytes.writeUInt16LE(240, 7);
    if (frames > 0) {
      bytes.writeUInt16LE(frames, 9);
      for (let index = 0; index < frames; index += 1) bytes.writeUInt16LE(20, 11 + index * 115_202);
    }
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const fetchDevice: typeof fetch = async (_input, init) => init?.method === "GET"
    ? new Response(JSON.stringify(status)) : new Response(null, { status: 204 });
  const client = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token: "test-secret", fetchDevice });
  await client.heartbeat();
  await client.uploadCover("track", makeAsset(0));
  await client.uploadAnimation(makeAsset(1));
  await client.uploadAnimation(makeAsset(20));
  assert.deepEqual(deadlines, [10_000, 10_000, 10_000, 15_000, 10_000, 90_000, 10_000, 357_000]);

  deadlines.length = 0;
  const overridden = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token: "test-secret", fetchDevice, timeoutMs: 1234 });
  await overridden.uploadAnimation(makeAsset(20));
  assert.deepEqual(deadlines, [1234, 1234]);
});

test("converted animation requires atomic staging space and reports capacity errors safely", async () => {
  const asset = convertGifToAnimation(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64"));
  let freeStorageBytes = asset.bytes.length + 32768 - 1;
  let uploadStatus = 204;
  let uploads = 0;
  const client = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token: "test-secret",
    fetchDevice: async (_input, init) => {
      if (init?.method === "GET") return new Response(JSON.stringify({ ...status, freeStorageBytes }));
      uploads++;
      return uploadStatus === 204 ? new Response(null, { status: 204 }) : new Response("test-secret from remote", { status: uploadStatus });
    } });
  await assert.rejects(client.uploadAnimation(asset), (error: Error) => /converted animation.*storage/i.test(error.message) && !error.message.includes("test-secret"));
  assert.equal(uploads, 0);
  freeStorageBytes++;
  await client.uploadAnimation(asset);
  assert.equal(uploads, 1);
  uploadStatus = 413;
  await assert.rejects(client.uploadAnimation(asset), (error: Error) => /converted animation.*storage/i.test(error.message) && !error.message.includes("test-secret"));
});
