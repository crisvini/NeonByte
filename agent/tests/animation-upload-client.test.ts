import assert from "node:assert/strict";
import test from "node:test";
import { AnimationStorageError, DeviceClient } from "../src/device/client.js";
import type { AnimationAsset } from "../src/media/animation.js";
import { encodeAnimationV2 } from "../src/media/animation-encoder.js";
import { decodeAnimationV2 } from "../src/media/animation-decoder.js";
import { buildFrameCountFixture } from "../scripts/benchmark-animation.js";

const status = { protocolVersion: "v1", firmwareVersion: "host", ip: "127.0.0.1", freeStorageBytes: 4_000_000, mode: "auto", activeScene: "gif" };
const capabilities = { formats: ["nbif-v1", "nbif-v2"], width: 240, height: 240, maxFrames: 20, maxDurationMs: 30_000,
  maxEncodedBytes: 2_359_296, maxChunkBytes: 1024, reserveBytes: 32_768, freeStorageBytes: 4_000_000 };

function makeAnimation(): AnimationAsset {
  const pixels = Buffer.alloc(240 * 240 * 2);
  let state = 0x7f4a7c15;
  for (let offset = 0; offset < pixels.length; offset += 2) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    pixels.writeUInt16LE((state >>> 0) & 0xffff, offset);
  }
  const encoded = encodeAnimationV2([{ pixels, delayMs: 70 }]);
  return encoded;
}

test("NBIF v2 uploads as short chunks and sends heartbeat/playback work between requests", async () => {
  const animation = makeAnimation();
  const requests: Array<{ path: string; method: string; bytes: number }> = [];
  let nextOffset = 0;
  let pollCount = 0;
  const client = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token: "test-secret", fetchDevice: async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const bytes = typeof init?.body === "string" ? Buffer.byteLength(init.body) : init?.body ? Buffer.from(init.body as Uint8Array).length : 0;
    requests.push({ path: url.pathname + url.search, method, bytes });
    if (url.pathname === "/api/v1/status") return new Response(JSON.stringify(status));
    if (url.pathname === "/api/v2/media-capabilities") return new Response(JSON.stringify(capabilities));
    if (url.pathname === "/api/v2/animation/uploads" && method === "POST") {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.sizeBytes, animation.bytes.length);
      assert.equal(body.sha256, animation.sha256);
      return new Response(JSON.stringify({ uploadId: "1234abcd", nextOffset: 0, state: "receiving" }), { status: 201 });
    }
    if (url.pathname.endsWith("/chunks")) {
      const offset = Number(url.searchParams.get("offset"));
      assert.equal(offset, nextOffset);
      assert.ok(bytes > 0 && bytes <= 1024);
      nextOffset += bytes;
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/complete")) return new Response(JSON.stringify({ state: "verifying" }), { status: 202 });
    if (url.pathname === "/api/v2/animation/uploads/1234abcd") {
      pollCount += 1;
      return new Response(JSON.stringify({ uploadId: "1234abcd", state: pollCount === 1 ? "verifying" : "installed",
        nextOffset, expectedBytes: animation.bytes.length, receivedBytes: nextOffset, error: "" }));
    }
    return new Response(null, { status: 204 });
  } });
  let controlTicks = 0;
  const snapshot = { status: "playing" as const, nowPlaying: { trackId: "track-1", title: "Title", artist: "Artist",
    isPlaying: true, durationMs: 60_000, progressMs: 1_000, sampledAtUnixMs: 1_700_000_000_000 },
    coverUrl: null, sampledAtUnixMs: 1_700_000_000_000 };
  await client.uploadAnimation(animation, async () => { controlTicks += 1; await client.serviceUploadControls(snapshot); });
  const chunks = requests.filter((request) => request.path.includes("/chunks"));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((request) => request.bytes <= 1024));
  assert.ok(controlTicks >= chunks.length);
  assert.equal(requests.some((request) => request.path === "/api/v1/animation"), false);
  const chunkIndexes = requests.map((request, index) => request.path.includes("/chunks") ? index : -1).filter((index) => index >= 0);
  assert.ok(chunkIndexes.length > 1);
  assert.ok(requests.slice(chunkIndexes[0]! + 1, chunkIndexes[1]!).some((request) => request.path === "/api/v1/spotify"));
  assert.ok(requests.slice(chunkIndexes[0]! + 1, chunkIndexes[1]!).some((request) => request.path === "/api/v1/heartbeat"));
  assert.ok(pollCount >= 2);
});

test("only an explicit capability 404 triggers an on-demand NBIF v1 fallback", async () => {
  const animation = makeAnimation();
  const decoded = decodeAnimationV2(animation.bytes);
  const expectedLegacy = Buffer.alloc(11 + decoded.frames.length * (2 + 240 * 240 * 2));
  expectedLegacy.write("NBIF", 0, "ascii");
  expectedLegacy[4] = 1;
  expectedLegacy.writeUInt16LE(240, 5);
  expectedLegacy.writeUInt16LE(240, 7);
  expectedLegacy.writeUInt16LE(decoded.frames.length, 9);
  let legacyOffset = 11;
  decoded.frames.forEach((frame, index) => {
    expectedLegacy.writeUInt16LE(decoded.delaysMs[index]!, legacyOffset);
    legacyOffset += 2;
    frame.copy(expectedLegacy, legacyOffset);
    legacyOffset += frame.length;
  });
  const paths: string[] = [];
  const client = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token: "test-secret", fetchDevice: async (input, init) => {
    const path = new URL(String(input)).pathname; paths.push(path);
    if (path === "/api/v1/status") return new Response(JSON.stringify(status));
    if (path === "/api/v2/media-capabilities") return new Response(null, { status: 404 });
    if (path === "/api/v1/animation") {
      assert.deepEqual(Buffer.from(init?.body as Uint8Array), expectedLegacy);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 204 });
  } });
  await client.uploadAnimation(animation);
  assert.ok(paths.includes("/api/v1/animation"));

  let legacySent = false;
  const ambiguous = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token: "test-secret", fetchDevice: async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/status") return new Response(JSON.stringify(status));
    if (path === "/api/v2/media-capabilities") return new Response(null, { status: 401 });
    if (path === "/api/v1/animation") legacySent = true;
    return new Response(null, { status: 204 });
  } });
  await assert.rejects(ambiguous.uploadAnimation(animation), /communication failed/);
  assert.equal(legacySent, false);

  let malformedFallback = false;
  const malformedCapabilities = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token: "test-secret", fetchDevice: async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/status") return new Response(JSON.stringify(status));
    if (path === "/api/v2/media-capabilities") return new Response(JSON.stringify({ ...capabilities, maxChunkBytes: 2048 }));
    if (path === "/api/v1/animation") malformedFallback = true;
    return new Response(null, { status: 204 });
  } });
  await assert.rejects(malformedCapabilities.uploadAnimation(animation), /invalid media capabilities/i);
  assert.equal(malformedFallback, false);
});

test("an authoritative v2 storage admission failure is reported without attempting v1", async () => {
  const animation = makeAnimation();
  const paths: string[] = [];
  const client = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token: "test-secret", fetchDevice: async (input) => {
    const path = new URL(String(input)).pathname; paths.push(path);
    if (path === "/api/v1/status") return new Response(JSON.stringify(status));
    if (path === "/api/v2/media-capabilities") return new Response(JSON.stringify(capabilities));
    if (path === "/api/v2/animation/uploads") {
      return new Response(JSON.stringify({ code: "insufficient_storage", message: "The candidate does not fit." }), { status: 507 });
    }
    return new Response(null, { status: 204 });
  } });
  await assert.rejects(client.uploadAnimation(animation), AnimationStorageError);
  assert.equal(paths.includes("/api/v1/animation"), false);
});

test("device frame capacity is enforced before upload for legacy and 60-frame firmware", async () => {
  const fixture = buildFrameCountFixture(48, "small-motion", 40);
  const animation = encodeAnimationV2(fixture.frames.map((pixels) => ({ pixels, delayMs: 40 })));
  const paths: string[] = [];
  const oldDevice = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token: "test-secret", fetchDevice: async (input) => {
    const url = new URL(String(input)); paths.push(url.pathname);
    if (url.pathname === "/api/v1/status") return new Response(JSON.stringify(status));
    if (url.pathname === "/api/v2/media-capabilities") return new Response(JSON.stringify(capabilities));
    return new Response(null, { status: 204 });
  } });
  await assert.rejects(oldDevice.uploadAnimation(animation), /20 animation frames|frame capacity/i);
  assert.equal(paths.includes("/api/v2/animation/uploads"), false);
  assert.equal(paths.includes("/api/v1/animation"), false);

  const legacyOnlyPaths: string[] = [];
  const legacyOnly = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token: "test-secret", fetchDevice: async (input) => {
    const path = new URL(String(input)).pathname; legacyOnlyPaths.push(path);
    if (path === "/api/v1/status") return new Response(JSON.stringify(status));
    if (path === "/api/v2/media-capabilities") return new Response(null, { status: 404 });
    return new Response(null, { status: 204 });
  } });
  await assert.rejects(legacyOnly.uploadAnimation(animation), /at most 20 animation frames/i);
  assert.equal(legacyOnlyPaths.includes("/api/v1/animation"), false);

  const modernCapabilities = { ...capabilities, maxFrames: 60 };
  let receivedBytes = 0;
  let polls = 0;
  const newDevice = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token: "test-secret", fetchDevice: async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/v1/status") return new Response(JSON.stringify(status));
    if (url.pathname === "/api/v2/media-capabilities") return new Response(JSON.stringify(modernCapabilities));
    if (url.pathname === "/api/v2/animation/uploads" && method === "POST") {
      return new Response(JSON.stringify({ uploadId: "60abc123", nextOffset: 0, state: "receiving" }), { status: 201 });
    }
    if (url.pathname.endsWith("/chunks")) {
      receivedBytes += Buffer.from(init?.body as Uint8Array).length;
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/complete")) return new Response(null, { status: 202 });
    if (url.pathname === "/api/v2/animation/uploads/60abc123") {
      polls += 1;
      return new Response(JSON.stringify({ uploadId: "60abc123", state: "installed", nextOffset: receivedBytes,
        expectedBytes: animation.bytes.length, receivedBytes, error: "" }));
    }
    return new Response(null, { status: 204 });
  } });
  await newDevice.uploadAnimation(animation);
  assert.equal(receivedBytes, animation.bytes.length);
  assert.ok(polls > 0);
});

