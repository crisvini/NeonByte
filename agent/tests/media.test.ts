import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createCoverAsset,
  convertGifToAnimation,
  validateGifFrameDescriptors,
  validateAnimation,
  validateCover,
} from "../src/media/animation.js";

const onePixelGif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const twoFrameGif = Buffer.concat([
  Buffer.from(onePixelGif.subarray(0, -1)),
  Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x07, 0x00, 0x00, 0x00]),
  Buffer.from([0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  Buffer.from([0x02, 0x01, 0x44, 0x00, 0x3b]),
]);
twoFrameGif[23] = 0x05;

const disposalTwoWithOpaqueBackgroundGif = Buffer.from(twoFrameGif);
disposalTwoWithOpaqueBackgroundGif[11] = 1;
disposalTwoWithOpaqueBackgroundGif[16] = 255;
disposalTwoWithOpaqueBackgroundGif[17] = 0;
disposalTwoWithOpaqueBackgroundGif[18] = 0;
disposalTwoWithOpaqueBackgroundGif[22] = 0x08;
disposalTwoWithOpaqueBackgroundGif[44] = 0x01;
disposalTwoWithOpaqueBackgroundGif[47] = 0;

const localPaletteGif = Buffer.concat([
  onePixelGif.subarray(0, 13),
  onePixelGif.subarray(19, 37),
  Buffer.from([0, 0, 0, 255, 255, 255]),
  onePixelGif.subarray(37),
]);
localPaletteGif[10] = 0;
localPaletteGif[30] = 0x80;

test("converts a valid GIF to a 240 by 240 RGB565 animation with a verifiable checksum", () => {
  const animation = convertGifToAnimation(onePixelGif);
  const metadata = validateAnimation(animation.bytes, animation.sha256);

  assert.equal(metadata.width, 240);
  assert.equal(metadata.height, 240);
  assert.equal(metadata.frameCount, 1);
  assert.equal(metadata.durationMs, 100);
  assert.equal(animation.sha256, createHash("sha256").update(animation.bytes).digest("hex"));
});

test("converts a valid GIF that uses a local palette without a global color table", () => {
  const animation = convertGifToAnimation(localPaletteGif);

  assert.equal(validateAnimation(animation.bytes, animation.sha256).frameCount, 1);
});

test("rejects invalid and over-limit GIF files with an actionable error", () => {
  assert.throws(() => convertGifToAnimation(Buffer.from("not a gif")), /invalid GIF/i);
  assert.throws(() => convertGifToAnimation(onePixelGif, { maxUploadBytes: 8 }), /\d+-byte limit/i);
});

test("preserves frame order and delays for a looping multi-frame GIF", () => {
  const animation = convertGifToAnimation(twoFrameGif);
  const metadata = validateAnimation(animation.bytes, animation.sha256);

  assert.equal(metadata.frameCount, 2);
  assert.equal(metadata.durationMs, 120);
  assert.equal(animation.bytes.readUInt16LE(11), 50);
  assert.equal(animation.bytes.readUInt16LE(11 + 2 + 240 * 240 * 2), 70);
});

test("restores the global GIF background color after disposal method 2", () => {
  const animation = convertGifToAnimation(disposalTwoWithOpaqueBackgroundGif);
  const secondFramePixelOffset = 11 + 2 + 240 * 240 * 2 + 2;

  assert.equal(animation.bytes.readUInt16LE(secondFramePixelOffset), 0xf800);
});

test("rejects GIF frame descriptors before decompression when their bounds or total pixel budget is exceeded", () => {
  assert.throws(
    () => validateGifFrameDescriptors(1, 1, [{ left: 0, top: 0, width: 65_535, height: 65_535 }]),
    /frame descriptor outside the screen bounds/i,
  );
  assert.throws(
    () => validateGifFrameDescriptors(2, 2, [
      { left: 0, top: 0, width: 2, height: 2 },
      { left: 0, top: 0, width: 2, height: 2 },
    ], { maxTotalFramePixels: 7 }),
    /total.*pixels/i,
  );
  const frameOutsideLogicalScreen = Buffer.from(onePixelGif);
  frameOutsideLogicalScreen.writeUInt16LE(2, 32);
  assert.throws(() => convertGifToAnimation(frameOutsideLogicalScreen), /frame descriptor outside the screen bounds/i);
});

test("converts a cropped 240 by 240 RGBA cover to RGB565 and validates its checksum", () => {
  const pixels = new Uint8Array(480 * 240 * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = 0;
    pixels[offset + 1] = 255;
    pixels[offset + 2] = 0;
    pixels[offset + 3] = 255;
  }
  const centerLeft = (120 * 4);
  pixels[centerLeft] = 255;
  pixels[centerLeft + 1] = 0;
  pixels[centerLeft + 2] = 0;

  const cover = createCoverAsset(pixels, 480, 240);
  const metadata = validateCover(cover.bytes, cover.sha256);

  assert.equal(metadata.width, 240);
  assert.equal(metadata.height, 240);
  assert.equal(cover.sha256, createHash("sha256").update(cover.bytes).digest("hex"));
  assert.equal(cover.bytes.readUInt16LE(9), 0xf800);
});

test("rejects a cover with mismatched pixel dimensions or checksum", () => {
  assert.throws(() => createCoverAsset(new Uint8Array(15), 2, 2), /pixel dimensions/i);
  const cover = createCoverAsset(new Uint8Array(240 * 240 * 4), 240, 240);
  assert.throws(() => validateCover(cover.bytes, "0".repeat(64)), /checksum/i);
});
