import assert from "node:assert/strict";
import { createServer } from "node:http";
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

test("explicit replacement confirms NBIF v2 compatibility, deletes the installed asset, then reuses chunk upload", async () => {
  const animation = makeAnimation();
  const events: string[] = [];
  const progress: string[] = [];
  let nextOffset = 0;
  let statusPolls = 0;
  const client = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token: "test-secret", fetchDevice: async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    events.push(`${method} ${url.pathname}`);
    if (url.pathname === "/api/v1/status") return new Response(JSON.stringify(status));
    if (url.pathname === "/api/v2/media-capabilities") return new Response(JSON.stringify(capabilities));
    if (url.pathname === "/api/v2/animation" && method === "DELETE") {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-secret");
      return new Response(JSON.stringify({ removed: true, freeStorageBytes: capabilities.freeStorageBytes }));
    }
    if (url.pathname === "/api/v2/animation/uploads" && method === "POST") {
      assert.ok(events.indexOf("DELETE /api/v2/animation") < events.indexOf("POST /api/v2/animation/uploads"));
      return new Response(JSON.stringify({ uploadId: "cafefeed", nextOffset: 0, state: "receiving" }), { status: 201 });
    }
    if (url.pathname.endsWith("/chunks")) {
      const offset = Number(url.searchParams.get("offset"));
      assert.equal(offset, nextOffset);
      nextOffset += Buffer.from(init?.body as Uint8Array).length;
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/complete")) return new Response(null, { status: 202 });
    if (url.pathname === "/api/v2/animation/uploads/cafefeed") {
      statusPolls += 1;
      return new Response(JSON.stringify({ uploadId: "cafefeed", state: "installed", nextOffset,
        expectedBytes: animation.bytes.length, receivedBytes: nextOffset, error: "" }));
    }
    return new Response(null, { status: 204 });
  } });
  let receipt: unknown;
  await client.replaceAnimation(animation, {
    onRemoved(value) { receipt = value; progress.push("removed"); },
    onStage(stage) { progress.push(stage); },
  });
  assert.deepEqual(receipt, { removed: true, freeStorageBytes: capabilities.freeStorageBytes });
  assert.equal(events[0], "GET /api/v1/status");
  assert.ok(events.indexOf("GET /api/v2/media-capabilities") < events.indexOf("DELETE /api/v2/animation"));
  assert.ok(events.indexOf("DELETE /api/v2/animation") < events.indexOf("POST /api/v2/animation/uploads"));
  assert.ok(events.some((event) => event.startsWith("PUT /api/v2/animation/uploads/cafefeed/chunks")));
  assert.equal(events.some((event) => event === "PUT /api/v1/animation"), false);
  assert.deepEqual(progress.slice(0, 2), ["removing", "removed"]);
  assert.ok(progress.includes("uploading"));
  assert.ok(progress.includes("validating"));
  assert.ok(statusPolls > 0);
});

test("a lost close-delimited removal receipt is diagnosed and the same converted asset can be retried safely", async () => {
  const animation = makeAnimation();
  const receipt = Buffer.from(JSON.stringify({ removed: true, freeStorageBytes: capabilities.freeStorageBytes }));
  let removalRequests = 0;
  let installedAnimation = true;
  let receivedBytes = 0;
  let unauthorized = false;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const method = request.method ?? "GET";
      const path = request.url ?? "/";
      if (!(method === "GET" && path === "/api/v1/status") && request.headers.authorization !== "Bearer replacement-test") {
        unauthorized = true;
        response.writeHead(401, { Connection: "close", "Content-Length": "0" }).end();
        return;
      }
      if (method === "GET" && path === "/api/v1/status") {
        response.writeHead(200, { "Content-Type": "application/json", Connection: "close" })
          .end(JSON.stringify({ ...status, freeStorageBytes: capabilities.freeStorageBytes }));
        return;
      }
      if (method === "GET" && path === "/api/v2/media-capabilities") {
        response.writeHead(200, { "Content-Type": "application/json", Connection: "close" }).end(JSON.stringify(capabilities));
        return;
      }
      if (method === "DELETE" && path === "/api/v2/animation") {
        removalRequests += 1;
        installedAnimation = false;
        if (removalRequests === 1) {
          response.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(receipt.length), Connection: "close" });
          response.flushHeaders();
          response.destroy();
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(receipt.length), Connection: "close" })
          .end(receipt);
        return;
      }
      if (method === "POST" && path === "/api/v2/animation/uploads") {
        assert.equal(installedAnimation, false, "retry deletion must be idempotent after the first response is lost");
        assert.deepEqual(JSON.parse(body.toString("utf8")), { sizeBytes: animation.bytes.length, sha256: animation.sha256 });
        response.writeHead(201, { "Content-Type": "application/json", Connection: "close" })
          .end(JSON.stringify({ uploadId: "b16b00b5", nextOffset: 0, state: "receiving" }));
        return;
      }
      if (method === "PUT" && path.startsWith("/api/v2/animation/uploads/b16b00b5/chunks?")) {
        receivedBytes += body.length;
        response.writeHead(204, { Connection: "close" }).end();
        return;
      }
      if (method === "POST" && path === "/api/v2/animation/uploads/b16b00b5/complete") {
        response.writeHead(202, { Connection: "close" }).end();
        return;
      }
      if (method === "GET" && path === "/api/v2/animation/uploads/b16b00b5") {
        response.writeHead(200, { "Content-Type": "application/json", Connection: "close" })
          .end(JSON.stringify({ uploadId: "b16b00b5", state: "installed", nextOffset: receivedBytes,
            expectedBytes: animation.bytes.length, receivedBytes, error: "" }));
        return;
      }
      response.writeHead(404, { Connection: "close", "Content-Length": "0" }).end();
    })().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new DeviceClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: "replacement-test" });
  try {
    await assert.rejects(client.replaceAnimation(animation), /HTTP 200.*connection closed.*receipt/i);
    assert.equal(removalRequests, 1);
    assert.equal(installedAnimation, false, "the simulated ESP completed the delete before losing its receipt");
    await client.replaceAnimation(animation);
    assert.equal(removalRequests, 2, "a retry repeats the authenticated idempotent removal");
    assert.equal(receivedBytes, animation.bytes.length, "the cached NBIF v2 is uploaded without reconversion");
    assert.equal(unauthorized, false, "all mutating requests carry the configured bearer credential");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("a firmware HTTP error preserves its status, code, and safe removal diagnostic", async () => {
  const animation = makeAnimation();
  const client = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token: "test-secret", fetchDevice: async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/status") return new Response(JSON.stringify(status));
    if (path === "/api/v2/media-capabilities") return new Response(JSON.stringify(capabilities));
    if (path === "/api/v2/animation" && init?.method === "DELETE") return new Response(JSON.stringify({
      code: "internal_error", message: "The installed animation could not be removed.",
    }), { status: 500, headers: { "Content-Type": "application/json", Connection: "close" } });
    return new Response(null, { status: 204 });
  } });
  await assert.rejects(client.replaceAnimation(animation),
    /HTTP 500, firmware code internal_error.*The installed animation could not be removed/i);
});

test("invalid or incompatible converted media is rejected before explicit removal", async () => {
  const animation = makeAnimation();
  const requests: string[] = [];
  const client = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token: "test-secret", fetchDevice: async (input) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path === "/api/v1/status") return new Response(JSON.stringify(status));
    if (path === "/api/v2/media-capabilities") return new Response(JSON.stringify({ ...capabilities, maxFrames: 0 }));
    return new Response(JSON.stringify({ removed: true, freeStorageBytes: capabilities.freeStorageBytes }));
  } });
  await assert.rejects(client.replaceAnimation(animation), /invalid media capabilities/i);
  assert.equal(requests.includes("/api/v2/animation"), false);

  requests.length = 0;
  await assert.rejects(client.replaceAnimation({ ...animation, sha256: "0".repeat(64) }), /checksum/i);
  assert.deepEqual(requests, []);
});

test("cancellation after removal cancels the existing v2 upload session", async () => {
  const animation = makeAnimation();
  const controller = new AbortController();
  const requests: Array<{ path: string; method: string }> = [];
  const client = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token: "test-secret", fetchDevice: async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({ path: url.pathname, method });
    if (url.pathname === "/api/v1/status") return new Response(JSON.stringify(status));
    if (url.pathname === "/api/v2/media-capabilities") return new Response(JSON.stringify(capabilities));
    if (url.pathname === "/api/v2/animation" && method === "DELETE") {
      return new Response(JSON.stringify({ removed: true, freeStorageBytes: capabilities.freeStorageBytes }));
    }
    if (url.pathname === "/api/v2/animation/uploads" && method === "POST") {
      return new Response(JSON.stringify({ uploadId: "badc0ffe", nextOffset: 0, state: "receiving" }), { status: 201 });
    }
    if (url.pathname.endsWith("/chunks")) {
      controller.abort();
      throw new Error("simulated client cancellation");
    }
    if (url.pathname === "/api/v2/animation/uploads/badc0ffe" && method === "DELETE") return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  } });
  await assert.rejects(client.replaceAnimation(animation, { signal: controller.signal }), /cancelled/i);
  assert.ok(requests.some(({ path, method }) => path === "/api/v2/animation" && method === "DELETE"));
  assert.ok(requests.some(({ path, method }) => path === "/api/v2/animation/uploads/badc0ffe" && method === "DELETE"),
    "the agent should cancel the staged candidate while the old installed animation remains removed");
});

test("a lost device connection after removal is reported as failure and cleans up or expires the candidate", async () => {
  const animation = makeAnimation();
  const requests: Array<{ path: string; method: string }> = [];
  let removalConfirmed = false;
  const client = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token: "test-secret", fetchDevice: async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({ path: url.pathname, method });
    if (url.pathname === "/api/v1/status") return new Response(JSON.stringify(status));
    if (url.pathname === "/api/v2/media-capabilities") return new Response(JSON.stringify(capabilities));
    if (url.pathname === "/api/v2/animation" && method === "DELETE") {
      removalConfirmed = true;
      return new Response(JSON.stringify({ removed: true, freeStorageBytes: capabilities.freeStorageBytes }));
    }
    if (url.pathname === "/api/v2/animation/uploads" && method === "POST") {
      return new Response(JSON.stringify({ uploadId: "decafbad", nextOffset: 0, state: "receiving" }), { status: 201 });
    }
    if (url.pathname.endsWith("/chunks")) throw new Error("simulated device disconnect during transfer");
    if (url.pathname === "/api/v2/animation/uploads/decafbad" && method === "GET") return new Response(null, { status: 404 });
    if (url.pathname === "/api/v2/animation/uploads/decafbad" && method === "DELETE") return new Response(null, { status: 404 });
    return new Response(null, { status: 404 });
  } });
  await assert.rejects(client.replaceAnimation(animation), /communication failed/i);
  assert.equal(removalConfirmed, true);
  assert.ok(requests.some(({ path, method }) => path.endsWith("/chunks") && method === "PUT"));
  assert.ok(requests.some(({ path, method }) => path === "/api/v2/animation/uploads/decafbad" && method === "DELETE"),
    "the agent should cancel the incomplete session, or let device expiry clean it up if it restarted");
  assert.equal(requests.some(({ path }) => path === "/api/v1/animation"), false);
});

test("a chunk timeout retries only the current v2 chunk and cancels the staged session", async () => {
  const animation = makeAnimation();
  const requests: Array<{ path: string; method: string }> = [];
  let chunks = 0;
  const client = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token: "test-secret", timeoutMs: 5,
    fetchDevice: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      requests.push({ path: url.pathname, method });
      if (url.pathname === "/api/v1/status") return new Response(JSON.stringify(status));
      if (url.pathname === "/api/v2/media-capabilities") return new Response(JSON.stringify(capabilities));
      if (url.pathname === "/api/v2/animation" && method === "DELETE") {
        return new Response(JSON.stringify({ removed: true, freeStorageBytes: capabilities.freeStorageBytes }));
      }
      if (url.pathname === "/api/v2/animation/uploads" && method === "POST") {
        return new Response(JSON.stringify({ uploadId: "feedcafe", nextOffset: 0, state: "receiving" }), { status: 201 });
      }
      if (url.pathname.endsWith("/chunks")) {
        chunks++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (init?.signal?.aborted) throw new Error("simulated request timeout");
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/api/v2/animation/uploads/feedcafe" && method === "GET") {
        return new Response(JSON.stringify({ uploadId: "feedcafe", state: "receiving", nextOffset: 0,
          expectedBytes: animation.bytes.length, receivedBytes: 0, error: "" }));
      }
      if (url.pathname === "/api/v2/animation/uploads/feedcafe" && method === "DELETE") return new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    } });
  await assert.rejects(client.replaceAnimation(animation), /communication failed/i);
  assert.equal(chunks, 2, "only the ambiguous chunk is retried once");
  assert.ok(requests.some(({ path, method }) => path === "/api/v2/animation/uploads/feedcafe" && method === "DELETE"));
});

