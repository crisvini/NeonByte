import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { encodeAnimationV2 } from "../src/media/animation-encoder.js";

const pixelsPerFrame = 240 * 240;

function makeFrames() {
  const first = Buffer.alloc(pixelsPerFrame * 2);
  for (let y = 0; y < 240; y += 1) {
    for (let x = 0; x < 240; x += 1) {
      const color = y < 120 ? y * 2 + (x < 120 ? 0 : 1) : ((y * 240 + x + 1000) & 0xffff);
      first.writeUInt16LE(color, (y * 240 + x) * 2);
    }
  }
  const second = Buffer.from(first);
  for (let x = 0; x < 240; x += 1) second.writeUInt16LE(0x07e0, (10 * 240 + x) * 2);
  const third = Buffer.from(second);
  const colors = [0xf800, 0x07e0, 0x001f, 0xffff];
  for (let x = 0; x < 240; x += 1) third.writeUInt16LE(colors[x % 4]!, (11 * 240 + x) * 2);
  return [
    { pixels: first, delayMs: 20 },
    { pixels: second, delayMs: 30 },
    { pixels: third, delayMs: 40 },
    { pixels: Buffer.from(third), delayMs: 50 },
  ];
}

test("browser preview reconstructs NBIF v2 raw, RGB565 RLE, indexed RLE, packed, delta and hold frames", async () => {
  const source = await readFile(new URL("../src/web/public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function decodeAnimation(bytes) {");
  const end = source.indexOf("\nfunction loadCover(", start);
  assert.ok(start >= 0 && end > start);
  const globals = {
    DISPLAY_SIZE: 240,
    ANIMATION_HEADER_BYTES: 11,
    context: { createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }) },
    DataView,
    TextDecoder,
    Uint8Array,
    Uint16Array,
    Uint8ClampedArray,
    Set,
    Math,
    Error,
  };
  runInNewContext(`${source.slice(start, end)}\nglobalThis.previewDecode = decodeAnimation;`, globals);
  const expected = makeFrames();
  const animation = encodeAnimationV2(expected);
  const exactBuffer = animation.bytes.buffer.slice(animation.bytes.byteOffset, animation.bytes.byteOffset + animation.bytes.byteLength);
  const preview = (globals as typeof globals & { previewDecode: (bytes: ArrayBuffer) => Array<{ image: { data: Uint8ClampedArray }; delayMs: number }> }).previewDecode(exactBuffer);
  assert.equal(preview.length, expected.length);
  assert.deepEqual(Array.from(preview, (frame) => frame.delayMs), expected.map((frame) => frame.delayMs));
  const samplePixels = [0, 119, 120, 240 * 10 + 7, 240 * 11, pixelsPerFrame - 1];
  for (let frameIndex = 0; frameIndex < expected.length; frameIndex += 1) {
    for (const pixel of samplePixels) {
      const color = expected[frameIndex]!.pixels.readUInt16LE(pixel * 2);
      const actual = preview[frameIndex]!.image.data;
      assert.deepEqual([...actual.subarray(pixel * 4, pixel * 4 + 4)], [
        Math.round(((color >> 11) & 31) * 255 / 31),
        Math.round(((color >> 5) & 63) * 255 / 63),
        Math.round((color & 31) * 255 / 31),
        255,
      ]);
    }
  }
});
