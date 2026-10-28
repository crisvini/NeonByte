import assert from "node:assert/strict";
import test from "node:test";
import {
  convertGifToAnimationV2,
} from "../src/media/animation.js";
import {
  decodeAnimationV2,
  encodeAnimationV2,
  validateAnimationV2,
} from "../src/media/animation-encoder.js";
import { buildRepresentativeCorpus } from "../scripts/benchmark-animation.js";

const WIDTH = 240;
const HEIGHT = 240;
const PIXEL_BYTES = WIDTH * HEIGHT * 2;

function solidFrame(color: number, delayMs: number): { pixels: Buffer; delayMs: number } {
  const pixels = Buffer.alloc(PIXEL_BYTES);
  for (let offset = 0; offset < pixels.length; offset += 2) pixels.writeUInt16LE(color, offset);
  return { pixels, delayMs };
}

test("NBIF v2 exactly reconstructs representative GIF frames and preserves delays", () => {
  for (const scenario of buildRepresentativeCorpus()) {
    const asset = convertGifToAnimationV2(scenario.gifBytes);
    const decoded = decodeAnimationV2(asset.bytes);
    assert.deepEqual(decoded.frames, scenario.frames, scenario.name);
    assert.deepEqual(decoded.delaysMs, scenario.delaysMs, scenario.name);
    assert.equal(asset.frameCount, scenario.frames.length);
  }
});

test("NBIF v2 uses exact RGB565 palettes, RLE, deltas, and holds without full frames", () => {
  const first = solidFrame(0xf800, 30);
  const same = solidFrame(0xf800, 70);
  const changed = solidFrame(0xf800, 90);
  for (let y = 20; y < 24; y += 1) {
    for (let x = 31; x < 39; x += 1) changed.pixels.writeUInt16LE(0x07e0, (y * WIDTH + x) * 2);
  }

  const asset = encodeAnimationV2([first, same, changed]);
  const { bytes } = asset;
  assert.equal(bytes.toString("ascii", 0, 4), "NBIF");
  assert.equal(bytes[4], 2);
  assert.deepEqual([0, 1, 2].map((index) => bytes[24 + index * 20 + 10]), [0, 2, 1]);
  assert.ok(bytes.length < 20_000);
  assert.deepEqual(decodeAnimationV2(bytes).frames, [first.pixels, same.pixels, changed.pixels]);
});

test("NBIF v2 falls back to raw RGB565 when a composed frame has more than 256 colors", () => {
  const frame = solidFrame(0, 50);
  for (let index = 0; index < 257; index += 1) {
    const x = index % WIDTH;
    const y = Math.floor(index / WIDTH);
    frame.pixels.writeUInt16LE(index + 1, (y * WIDTH + x) * 2);
  }
  const asset = encodeAnimationV2([frame]);
  const entry = 24;
  assert.equal(asset.bytes.readUInt16LE(entry + 12), 0);
  assert.equal(asset.bytes[entry + 11], 0);
  assert.deepEqual(decodeAnimationV2(asset.bytes).frames[0], frame.pixels);
});

test("NBIF v2 validator rejects truncation, trailing bytes, invalid records, and digest mismatches", () => {
  const asset = encodeAnimationV2([solidFrame(0xffff, 20)]);
  for (let length = 0; length < asset.bytes.length; length += 1) {
    assert.throws(() => validateAnimationV2(asset.bytes.subarray(0, length)), /checksum|incomplete|invalid|header/i,
      `truncation at byte ${length} must be rejected`);
  }
  assert.throws(() => validateAnimationV2(asset.bytes.subarray(0, asset.bytes.length - 1), asset.sha256), /checksum|incomplete|invalid/i);
  assert.throws(() => validateAnimationV2(Buffer.concat([asset.bytes, Buffer.from([0])]), asset.sha256), /checksum|trailing|invalid/i);
  assert.throws(() => validateAnimationV2(asset.bytes, "0".repeat(64)), /checksum/i);

  const malformed = Buffer.from(asset.bytes);
  malformed[44 + 3] = 99;
  assert.throws(() => validateAnimationV2(malformed), /codec|invalid|record/i);
});

