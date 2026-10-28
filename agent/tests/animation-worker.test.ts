import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as animation from "../src/media/animation.js";
import { decodeAnimationV2 } from "../src/media/animation-decoder.js";
import { buildFrameCountFixture } from "../scripts/benchmark-animation.js";

interface WorkerConversionApi {
  convertGifToAnimationV2InWorker(
    input: Uint8Array,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<animation.AnimationAsset>;
}

const conversionApi = animation as typeof animation & Partial<WorkerConversionApi>;

test("v2 worker conversion leaves the agent event loop responsive and preserves every frame", async () => {
  assert.equal(typeof conversionApi.convertGifToAnimationV2InWorker, "function");
  const fixture = buildFrameCountFixture(48, "small-motion", 40);
  let eventLoopServiced = false;
  const converted = conversionApi.convertGifToAnimationV2InWorker!(fixture.gifBytes);
  await new Promise<void>((resolve) => setImmediate(() => {
    eventLoopServiced = true;
    resolve();
  }));
  assert.equal(eventLoopServiced, true);

  const asset = await converted;
  const decoded = decodeAnimationV2(asset.bytes);
  assert.equal(asset.frameCount, 48);
  assert.equal(asset.durationMs, 1_920);
  assert.deepEqual(decoded.delaysMs, fixture.delaysMs);
  assert.deepEqual(decoded.frames, fixture.frames);
  assert.equal(asset.legacy, undefined);
});

test("v2 worker conversion rejects malformed LZW data and honors cancellation and deadline", async () => {
  assert.equal(typeof conversionApi.convertGifToAnimationV2InWorker, "function");
  const fixture = buildFrameCountFixture(1, "static-holds");
  const malformed = Buffer.from(fixture.gifBytes);
  const imageDescriptor = malformed.indexOf(0x2c, 13);
  malformed[imageDescriptor + 12] = 0xff;
  await assert.rejects(conversionApi.convertGifToAnimationV2InWorker!(malformed), /LZW|compressed image data|invalid GIF/i);

  const controller = new AbortController();
  const cancelled = conversionApi.convertGifToAnimationV2InWorker!(fixture.gifBytes, { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, /cancelled/i);
  await assert.rejects(
    conversionApi.convertGifToAnimationV2InWorker!(fixture.gifBytes, { timeoutMs: 1 }),
    /10-second|deadline/i,
  );
});

test("v2 worker conversion accepts only one active request and one bounded pending request", async () => {
  assert.equal(typeof conversionApi.convertGifToAnimationV2InWorker, "function");
  const fixture = buildFrameCountFixture(1, "static-holds");
  const active = conversionApi.convertGifToAnimationV2InWorker!(fixture.gifBytes);
  const pending = conversionApi.convertGifToAnimationV2InWorker!(fixture.gifBytes);
  await assert.rejects(
    conversionApi.convertGifToAnimationV2InWorker!(fixture.gifBytes),
    /busy|pending|queue/i,
  );
  const [activeAsset, pendingAsset] = await Promise.all([active, pending]);
  assert.equal(activeAsset.frameCount, 1);
  assert.equal(pendingAsset.frameCount, 1);
});


test("real astronaut GIF retains its 48 RGB565 frames and 40 ms delays", {
  skip: !process.env["NEONBYTE_ASTRONAUT_GIF"],
}, async () => {
  const input = await readFile(process.env["NEONBYTE_ASTRONAUT_GIF"]!);
  const expected = JSON.parse(await readFile(new URL("./fixtures/astronaut-rgb565-frame-hashes.json", import.meta.url), "utf8")) as {
    sourceSha256: string;
    frameHashes: string[];
  };
  assert.equal(createHash("sha256").update(input).digest("hex"), expected.sourceSha256);
  const asset = await conversionApi.convertGifToAnimationV2InWorker!(input);
  const decoded = decodeAnimationV2(asset.bytes);
  const actualHashes = decoded.frames.map((frame) => createHash("sha256").update(frame).digest("hex"));
  assert.equal(asset.frameCount, 48);
  assert.equal(asset.durationMs, 1_920);
  assert.deepEqual(decoded.delaysMs, Array(48).fill(40));
  assert.deepEqual(actualHashes, expected.frameHashes);
  assert.equal(asset.bytes.length, 229_645);
  assert.equal(asset.legacy, undefined);
});

test("Polish Waiting GIF remains pixel- and delay-identical to NBIF v1", {
  skip: !process.env["NEONBYTE_POLISH_WAITING_GIF"],
}, async () => {
  const input = await readFile(process.env["NEONBYTE_POLISH_WAITING_GIF"]!);
  const sourceSha256 = createHash("sha256").update(input).digest("hex");
  assert.equal(sourceSha256, "d79a0eabf792bace74042eb937ef653fb504eca7ca3a115f6d05bc77d046e19a");

  const v1 = animation.convertGifToAnimation(input);
  const v2 = await conversionApi.convertGifToAnimationV2InWorker!(input);
  assert.equal(v2.sha256, "18463a47694680e1fa72b74b1fea74b5687e3b621e8b1a4622314da74b1e8bd8");
  assert.equal(v2.frameCount, 14);
  assert.equal(v2.durationMs, 1_400);
  assert.equal(v1.frameCount, v2.frameCount);

  const decoded = decodeAnimationV2(v2.bytes);
  const frameBytes = animation.COVER_BYTES;
  assert.deepEqual(decoded.delaysMs, Array(14).fill(100));
  for (let index = 0; index < v2.frameCount; index += 1) {
    const v1Offset = animation.ANIMATION_HEADER_BYTES + index * (2 + frameBytes);
    assert.equal(v1.bytes.readUInt16LE(v1Offset), decoded.delaysMs[index]);
    assert.deepEqual(
      decoded.frames[index],
      v1.bytes.subarray(v1Offset + 2, v1Offset + 2 + frameBytes),
      `frame ${index} must retain its RGB565 pixels`,
    );
  }
});
