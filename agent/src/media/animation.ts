import { createHash } from "node:crypto";
import { decompressFrame, parseGIF, type ParsedFrameWithoutPatch, type ParsedGif } from "gifuct-js";
import { AnimationV2StreamEncoder } from "./animation-encoder.js";

export const DISPLAY_WIDTH = 240;
export const DISPLAY_HEIGHT = 240;
export const ANIMATION_MAGIC = "NBIF";
export const COVER_MAGIC = "NBIC";
export const MEDIA_VERSION = 1;
export const COVER_BYTES = DISPLAY_WIDTH * DISPLAY_HEIGHT * 2;
export const ANIMATION_HEADER_BYTES = 11;
export const COVER_HEADER_BYTES = 9;

export interface AnimationLimits {
  maxUploadBytes?: number;
  maxFrames?: number;
  maxFramePixels?: number;
  maxTotalFramePixels?: number;
  maxDurationMs?: number;
}

export interface GifFrameDescriptor {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MediaAsset {
  bytes: Buffer;
  sha256: string;
}

export interface AnimationAsset extends MediaAsset {
  frameCount: number;
  durationMs: number;
  legacy?: MediaAsset;
}

export interface MediaMetadata {
  width: number;
  height: number;
  frameCount?: number;
  durationMs?: number;
  sha256: string;
}

const DEFAULT_LIMITS = {
  maxUploadBytes: 8 * 1024 * 1024,
  maxFrames: 20,
  maxFramePixels: 1_048_576,
  maxTotalFramePixels: 4_194_304,
  maxDurationMs: 30_000,
};

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function byteView(input: Uint8Array): Buffer {
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

function rgbaToRgb565(r: number, g: number, b: number, alpha: number): number {
  const opacity = alpha / 255;
  const red = Math.round(r * opacity);
  const green = Math.round(g * opacity);
  const blue = Math.round(b * opacity);
  return ((red >> 3) << 11) | ((green >> 2) << 5) | (blue >> 3);
}

function coverScale(source: Uint8Array, sourceWidth: number, sourceHeight: number): Uint8Array {
  const output = new Uint8Array(DISPLAY_WIDTH * DISPLAY_HEIGHT * 4);
  const scale = Math.max(DISPLAY_WIDTH / sourceWidth, DISPLAY_HEIGHT / sourceHeight);
  const visibleWidth = DISPLAY_WIDTH / scale;
  const visibleHeight = DISPLAY_HEIGHT / scale;
  const left = (sourceWidth - visibleWidth) / 2;
  const top = (sourceHeight - visibleHeight) / 2;

  for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor(top + (y + 0.5) / scale));
    for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor(left + (x + 0.5) / scale));
      const sourceOffset = (sourceY * sourceWidth + sourceX) * 4;
      const targetOffset = (y * DISPLAY_WIDTH + x) * 4;
      output[targetOffset] = source[sourceOffset] ?? 0;
      output[targetOffset + 1] = source[sourceOffset + 1] ?? 0;
      output[targetOffset + 2] = source[sourceOffset + 2] ?? 0;
      output[targetOffset + 3] = source[sourceOffset + 3] ?? 0;
    }
  }
  return output;
}

function rgb565Pixels(rgba: Uint8Array): Buffer {
  const pixels = Buffer.alloc(COVER_BYTES);
  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 2) {
    pixels.writeUInt16LE(rgbaToRgb565(
      rgba[source] ?? 0,
      rgba[source + 1] ?? 0,
      rgba[source + 2] ?? 0,
      rgba[source + 3] ?? 0,
    ), target);
  }
  return pixels;
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > DEFAULT_LIMITS.maxFramePixels) {
    throw new Error("Image dimensions are invalid for the 240 × 240 preview.");
  }
}

export function validateGifFrameDescriptors(
  canvasWidth: number,
  canvasHeight: number,
  descriptors: readonly GifFrameDescriptor[],
  limits: Pick<AnimationLimits, "maxFramePixels" | "maxTotalFramePixels"> = {},
): void {
  const maxFramePixels = limits.maxFramePixels ?? DEFAULT_LIMITS.maxFramePixels;
  const maxTotalFramePixels = limits.maxTotalFramePixels ?? DEFAULT_LIMITS.maxTotalFramePixels;
  let totalFramePixels = 0;

  for (const descriptor of descriptors) {
    const { left, top, width, height } = descriptor;
    const framePixels = width * height;
    if (
      !Number.isInteger(left) || !Number.isInteger(top) ||
      !Number.isInteger(width) || !Number.isInteger(height) ||
      left < 0 || top < 0 || width < 1 || height < 1 ||
      left + width > canvasWidth || top + height > canvasHeight ||
      framePixels > maxFramePixels
    ) {
      throw new Error("The GIF contains a frame descriptor outside the screen bounds.");
    }

    totalFramePixels += framePixels;
    if (totalFramePixels > maxTotalFramePixels) {
      throw new Error(`The GIF exceeds the total frame limit of ${maxTotalFramePixels} pixels.`);
    }
  }
}

function indexedFrameToCanvas(frame: ParsedFrameWithoutPatch, canvas: Uint8Array, width: number, height: number): void {
  const { left, top, width: frameWidth, height: frameHeight } = frame.dims;
  if (
    !Number.isInteger(left) || !Number.isInteger(top) ||
    left < 0 || top < 0 || frameWidth < 1 || frameHeight < 1 ||
    left + frameWidth > width || top + frameHeight > height ||
    frame.pixels.length !== frameWidth * frameHeight
  ) {
    throw new Error("The GIF contains an invalid frame and cannot be previewed.");
  }

  for (let y = 0; y < frameHeight; y += 1) {
    for (let x = 0; x < frameWidth; x += 1) {
      const patchOffset = y * frameWidth + x;
      const targetOffset = ((top + y) * width + left + x) * 4;
      const colorIndex = frame.pixels[patchOffset];
      if (colorIndex === undefined || !Number.isInteger(colorIndex) || colorIndex < 0 || colorIndex >= frame.colorTable.length) {
        throw new Error("The GIF contains an invalid palette index.");
      }
      if (colorIndex === frame.transparentIndex) {
        continue;
      }
      const color = frame.colorTable[colorIndex];
      if (!color) throw new Error("The GIF contains an invalid palette index.");
      canvas[targetOffset] = color[0];
      canvas[targetOffset + 1] = color[1];
      canvas[targetOffset + 2] = color[2];
      canvas[targetOffset + 3] = 255;
    }
  }
}

function clearFrame(
  canvas: Uint8Array,
  frame: ParsedFrameWithoutPatch,
  width: number,
  background: readonly [number, number, number] | null,
): void {
  const { left, top, width: frameWidth, height: frameHeight } = frame.dims;
  for (let y = 0; y < frameHeight; y += 1) {
    for (let x = 0; x < frameWidth; x += 1) {
      const offset = ((top + y) * width + left + x) * 4;
      canvas[offset] = background?.[0] ?? 0;
      canvas[offset + 1] = background?.[1] ?? 0;
      canvas[offset + 2] = background?.[2] ?? 0;
      canvas[offset + 3] = background ? 255 : 0;
    }
  }
}

interface GifPreflight {
  width: number;
  height: number;
  frameCount: number;
  durationMs: number;
  sourcePixels: number;
}

function skipSubBlocks(bytes: Buffer, start: number): { next: number; totalBytes: number; blockCount: number } {
  let cursor = start;
  let totalBytes = 0;
  let blockCount = 0;
  while (cursor < bytes.length) {
    const size = bytes[cursor++]!;
    if (size === 0) return { next: cursor, totalBytes, blockCount };
    if (size > bytes.length - cursor) throw new Error("The GIF contains truncated extension or image data.");
    totalBytes += size;
    blockCount += 1;
    if (blockCount > 65_536) throw new Error("The GIF contains too many compressed data sub-blocks.");
    cursor += size;
  }
  throw new Error("The GIF contains an unterminated data block.");
}

function preflightGif(bytes: Buffer, limits: {
  maxFrames: number;
  maxFramePixels: number;
  maxTotalFramePixels: number;
  maxDurationMs: number;
}): GifPreflight {
  if (bytes.length < 13) throw new Error("The GIF header or logical screen descriptor is incomplete.");
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  const packed = bytes[10]!;
  if (width < 1 || height < 1 || width * height > limits.maxFramePixels) {
    throw new Error("The GIF dimensions are too large for the 240 × 240 preview.");
  }

  let cursor = 13;
  if (packed & 0x80) cursor += 3 * (1 << ((packed & 0x07) + 1));
  if (cursor > bytes.length) throw new Error("The GIF global color table is truncated.");
  let frameCount = 0;
  let sourcePixels = 0;
  let durationMs = 0;
  let pendingDelayMs = 100;
  let trailerSeen = false;
  let topLevelBlocks = 0;
  let totalSubBlocks = 0;

  while (cursor < bytes.length) {
    const marker = bytes[cursor++]!;
    if (marker === 0x3b) {
      trailerSeen = true;
      break;
    }
    topLevelBlocks += 1;
    if (topLevelBlocks > 4_096) throw new Error("The GIF contains too many extension or image blocks.");
    if (marker === 0x21) {
      if (cursor >= bytes.length) throw new Error("The GIF extension is truncated.");
      const label = bytes[cursor++]!;
      if (label === 0xf9) {
        if (cursor + 6 > bytes.length || bytes[cursor] !== 4 || bytes[cursor + 5] !== 0) {
          throw new Error("The GIF graphic control extension is malformed.");
        }
        const delayCentiseconds = bytes.readUInt16LE(cursor + 2);
        pendingDelayMs = delayCentiseconds === 0 ? 100 : delayCentiseconds * 10;
        cursor += 6;
      } else if (label === 0xff || label === 0x01) {
        if (cursor >= bytes.length) throw new Error("The GIF extension header is truncated.");
        const headerBytes = bytes[cursor++]!;
        if (headerBytes > bytes.length - cursor) throw new Error("The GIF extension header is truncated.");
        cursor += headerBytes;
        const blocks = skipSubBlocks(bytes, cursor);
        totalSubBlocks += blocks.blockCount;
        if (totalSubBlocks > 65_536) throw new Error("The GIF contains too many compressed data sub-blocks.");
        cursor = blocks.next;
      } else {
        const blocks = skipSubBlocks(bytes, cursor);
        totalSubBlocks += blocks.blockCount;
        if (totalSubBlocks > 65_536) throw new Error("The GIF contains too many compressed data sub-blocks.");
        cursor = blocks.next;
      }
      continue;
    }
    if (marker !== 0x2c) throw new Error("The GIF contains an unknown block marker.");
    if (cursor + 9 > bytes.length) throw new Error("The GIF image descriptor is truncated.");
    const left = bytes.readUInt16LE(cursor);
    const top = bytes.readUInt16LE(cursor + 2);
    const frameWidth = bytes.readUInt16LE(cursor + 4);
    const frameHeight = bytes.readUInt16LE(cursor + 6);
    const descriptorPacked = bytes[cursor + 8]!;
    cursor += 9;
    const framePixels = frameWidth * frameHeight;
    if (frameWidth < 1 || frameHeight < 1 || left + frameWidth > width || top + frameHeight > height || framePixels > limits.maxFramePixels) {
      throw new Error("The GIF contains a frame descriptor outside the screen bounds.");
    }
    if (descriptorPacked & 0x80) cursor += 3 * (1 << ((descriptorPacked & 0x07) + 1));
    if (cursor >= bytes.length) throw new Error("The GIF local color table or image data is truncated.");
    const minCodeSize = bytes[cursor++]!;
    if (minCodeSize < 2 || minCodeSize > 8) throw new Error("The GIF LZW minimum code size is invalid.");
    const blocks = skipSubBlocks(bytes, cursor);
    totalSubBlocks += blocks.blockCount;
    if (totalSubBlocks > 65_536) throw new Error("The GIF contains too many compressed data sub-blocks.");
    if (blocks.totalBytes === 0) throw new Error("The GIF compressed image data is empty.");
    cursor = blocks.next;
    frameCount += 1;
    if (frameCount > limits.maxFrames) {
      throw new Error(`The GIF has ${frameCount} frames; the animation conversion limit is ${limits.maxFrames}. Choose a GIF with fewer frames.`);
    }
    sourcePixels += framePixels;
    if (sourcePixels > limits.maxTotalFramePixels) {
      throw new Error(`The GIF exceeds the total frame limit of ${limits.maxTotalFramePixels} pixels.`);
    }
    durationMs += Math.max(20, pendingDelayMs);
    if (durationMs > limits.maxDurationMs) throw new Error(`The animation exceeds the ${limits.maxDurationMs} ms preview limit.`);
    pendingDelayMs = 100;
  }
  if (!trailerSeen || cursor !== bytes.length) throw new Error("The GIF is missing its trailer or contains trailing bytes.");
  if (frameCount === 0) throw new Error("The GIF contains no image frames.");
  return { width, height, frameCount, durationMs, sourcePixels };
}

function validateGifLzw(minCodeSize: number, data: ArrayLike<number>, expectedPixels: number): void {
  if (!Number.isInteger(minCodeSize) || minCodeSize < 2 || minCodeSize > 8 || data.length === 0) {
    throw new Error("The GIF compressed image data has an invalid LZW header.");
  }
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const lengths = new Uint16Array(4096);
  let available = clearCode + 2;
  let codeSize = minCodeSize + 1;
  let bitOffset = 0;
  let oldCode = -1;
  let outputPixels = 0;
  let ended = false;
  for (let literal = 0; literal < clearCode; literal += 1) lengths[literal] = 1;

  while (bitOffset + codeSize <= data.length * 8) {
    let code = 0;
    for (let bit = 0; bit < codeSize; bit += 1) {
      code |= ((data[bitOffset >> 3]! >> (bitOffset & 7)) & 1) << bit;
      bitOffset += 1;
    }
    if (code === clearCode) {
      available = clearCode + 2;
      codeSize = minCodeSize + 1;
      oldCode = -1;
      continue;
    }
    if (code === endCode) {
      ended = true;
      break;
    }
    if (oldCode < 0) {
      if (code >= clearCode) throw new Error("The GIF LZW stream does not begin with a literal after clear.");
      outputPixels += 1;
      oldCode = code;
      continue;
    }
    if (code > available || code >= 4096) throw new Error("The GIF LZW stream contains an invalid code.");
    const phraseLength = code === available ? lengths[oldCode]! + 1 : lengths[code]!;
    if (phraseLength === 0) throw new Error("The GIF LZW stream references an undefined code.");
    outputPixels += phraseLength;
    if (outputPixels > expectedPixels) throw new Error("The GIF LZW stream produces too many pixels.");
    if (available < 4096) {
      lengths[available] = lengths[oldCode]! + 1;
      available += 1;
      if (available === (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    oldCode = code;
  }
  if (!ended || outputPixels !== expectedPixels) throw new Error("The GIF LZW stream is incomplete or does not match its image dimensions.");
}

function exactArrayBuffer(bytes: Buffer): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer as ArrayBuffer;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function rgb565Canvas(canvas: Uint8Array, width: number, height: number): Buffer {
  const output = Buffer.alloc(COVER_BYTES);
  const scale = Math.max(DISPLAY_WIDTH / width, DISPLAY_HEIGHT / height);
  const visibleWidth = DISPLAY_WIDTH / scale;
  const visibleHeight = DISPLAY_HEIGHT / scale;
  const left = (width - visibleWidth) / 2;
  const top = (height - visibleHeight) / 2;
  for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor(top + (y + 0.5) / scale));
    for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor(left + (x + 0.5) / scale));
      const sourceOffset = (sourceY * width + sourceX) * 4;
      const targetOffset = (y * DISPLAY_WIDTH + x) * 2;
      output.writeUInt16LE(rgbaToRgb565(canvas[sourceOffset] ?? 0, canvas[sourceOffset + 1] ?? 0,
        canvas[sourceOffset + 2] ?? 0, canvas[sourceOffset + 3] ?? 0), targetOffset);
    }
  }
  return output;
}

function writeHeader(buffer: Buffer, magic: string, frameCount?: number): void {
  buffer.write(magic, 0, 4, "ascii");
  buffer.writeUInt8(MEDIA_VERSION, 4);
  buffer.writeUInt16LE(DISPLAY_WIDTH, 5);
  buffer.writeUInt16LE(DISPLAY_HEIGHT, 7);
  if (frameCount !== undefined) {
    buffer.writeUInt16LE(frameCount, 9);
  }
}

function convertGif(input: Uint8Array, limits: AnimationLimits, version: 1 | 2): AnimationAsset {
  const maxUploadBytes = limits.maxUploadBytes ?? DEFAULT_LIMITS.maxUploadBytes;
  const maxFrames = Math.min(limits.maxFrames ?? (version === 1 ? 20 : 60), version === 1 ? 20 : 60);
  const maxFramePixels = Math.min(limits.maxFramePixels ?? DEFAULT_LIMITS.maxFramePixels, DEFAULT_LIMITS.maxFramePixels);
  const maxTotalFramePixels = Math.min(limits.maxTotalFramePixels ?? (version === 1 ? DEFAULT_LIMITS.maxTotalFramePixels : 16_777_216),
    version === 1 ? DEFAULT_LIMITS.maxTotalFramePixels : 16_777_216);
  const maxDurationMs = limits.maxDurationMs ?? DEFAULT_LIMITS.maxDurationMs;
  if (input.byteLength > maxUploadBytes) {
    throw new Error(`The GIF exceeds the ${maxUploadBytes}-byte limit.`);
  }
  const signature = Buffer.from(input.subarray(0, 6)).toString("ascii");
  if (signature !== "GIF87a" && signature !== "GIF89a") {
    throw new Error("Invalid GIF: the file has no recognized GIF signature.");
  }

  try {
    const copy = byteView(input);
    const preflight = preflightGif(copy, { maxFrames, maxFramePixels, maxTotalFramePixels, maxDurationMs });
    const gif: ParsedGif = parseGIF(exactArrayBuffer(copy));
    const width = gif.lsd.width;
    const height = gif.lsd.height;
    if (width !== preflight.width || height !== preflight.height) throw new Error("The GIF logical screen changed during parsing.");
    const canvas = new Uint8Array(width * height * 4);
    let restorePrevious: Uint8Array | null = null;
    let previousFrame: ParsedFrameWithoutPatch | null = null;
    let durationMs = 0;
    const backgroundIndex = gif.lsd.backgroundColorIndex;
    const backgroundColor = gif.gct?.[backgroundIndex] ?? null;
    const composedFrames: Array<{ pixels: Buffer; delayMs: number }> = [];
    const encoder = version === 2 ? new AnimationV2StreamEncoder() : null;

    for (const parsedFrame of gif.frames) {
      if (!("image" in parsedFrame)) continue;
      validateGifLzw(parsedFrame.image.data.minCodeSize, parsedFrame.image.data.blocks, parsedFrame.image.descriptor.width * parsedFrame.image.descriptor.height);
      const frame = decompressFrame(parsedFrame, gif.gct ?? [], false);
      if (previousFrame?.disposalType === 2) {
        const backgroundIsTransparent = previousFrame.transparentIndex === backgroundIndex;
        clearFrame(canvas, previousFrame, width, backgroundIsTransparent ? null : backgroundColor);
      } else if (previousFrame?.disposalType === 3 && restorePrevious) {
        canvas.set(restorePrevious);
      }

      const savedCanvas = frame.disposalType === 3 ? canvas.slice() : null;
      indexedFrameToCanvas(frame, canvas, width, height);
      const delayMs = Math.max(20, frame.delay > 0 ? Math.trunc(frame.delay) : 100);
      durationMs += delayMs;
      if (durationMs > maxDurationMs) {
        throw new Error(`The animation exceeds the ${maxDurationMs} ms preview limit.`);
      }
      const pixels = rgb565Canvas(canvas, width, height);
      if (encoder) encoder.addFrame({ pixels, delayMs });
      else composedFrames.push({ pixels, delayMs });
      restorePrevious = savedCanvas;
      previousFrame = frame;
    }

    if (durationMs !== preflight.durationMs) throw new Error("The GIF frame delays changed during parsing.");
    if (encoder) return encoder.finish();

    const bytes = Buffer.alloc(ANIMATION_HEADER_BYTES + composedFrames.reduce((size, frame) => size + 2 + frame.pixels.length, 0));
    writeHeader(bytes, ANIMATION_MAGIC, composedFrames.length);
    let offset = ANIMATION_HEADER_BYTES;
    for (const frame of composedFrames) {
      bytes.writeUInt16LE(frame.delayMs, offset);
      offset += 2;
      frame.pixels.copy(bytes, offset);
      offset += frame.pixels.length;
    }
    const sha256 = digest(bytes);
    validateAnimation(bytes, sha256, { maxFrames, maxDurationMs });
    return { bytes, sha256, frameCount: composedFrames.length, durationMs };
  } catch (error) {
    if (error instanceof Error && /gif|limit|dimensions|descriptor|pixels|frames|animation|preview|lzw|palette|image data|color table|screen descriptor|nbif v2/i.test(error.message)) {
      throw error;
    }
    throw new Error("Invalid or unsupported GIF. Choose a smaller animated GIF and try again.");
  }
}

export function convertGifToAnimation(input: Uint8Array, limits: AnimationLimits = {}): AnimationAsset {
  return convertGif(input, limits, 1);
}

export function convertGifToAnimationV2(input: Uint8Array, limits: AnimationLimits = {}): AnimationAsset {
  return convertGif(input, limits, 2);
}

export function validateAnimation(
  input: Uint8Array,
  expectedSha256: string,
  limits: Pick<AnimationLimits, "maxFrames" | "maxDurationMs"> = {},
): MediaMetadata {
  const bytes = byteView(input);
  const maxFrames = limits.maxFrames ?? DEFAULT_LIMITS.maxFrames;
  const maxDurationMs = limits.maxDurationMs ?? DEFAULT_LIMITS.maxDurationMs;
  if (expectedSha256 !== digest(bytes)) {
    throw new Error("The animation checksum does not match.");
  }
  if (bytes.length < ANIMATION_HEADER_BYTES || bytes.toString("ascii", 0, 4) !== ANIMATION_MAGIC || bytes.readUInt8(4) !== MEDIA_VERSION) {
    throw new Error("The animation format is invalid or unsupported.");
  }
  const width = bytes.readUInt16LE(5);
  const height = bytes.readUInt16LE(7);
  const frameCount = bytes.readUInt16LE(9);
  if (width !== DISPLAY_WIDTH || height !== DISPLAY_HEIGHT || frameCount < 1 || frameCount > maxFrames) {
    throw new Error("The animation dimensions or frame count exceed the limit.");
  }
  const frameBytes = COVER_BYTES + 2;
  if (bytes.length !== ANIMATION_HEADER_BYTES + frameCount * frameBytes) {
    throw new Error("The animation file is incomplete or contains trailing data.");
  }
  let durationMs = 0;
  for (let index = 0, offset = ANIMATION_HEADER_BYTES; index < frameCount; index += 1, offset += frameBytes) {
    const delayMs = bytes.readUInt16LE(offset);
    if (delayMs < 20) {
      throw new Error("An animation frame has invalid timing.");
    }
    durationMs += delayMs;
  }
  if (durationMs > maxDurationMs) {
    throw new Error("The animation duration exceeds the preview limit.");
  }
  return { width, height, frameCount, durationMs, sha256: expectedSha256 };
}

export function createCoverAsset(input: Uint8Array, sourceWidth: number, sourceHeight: number): MediaAsset {
  assertDimensions(sourceWidth, sourceHeight);
  if (input.byteLength !== sourceWidth * sourceHeight * 4) {
    throw new Error("The cover pixel dimensions do not match the submitted data.");
  }
  const scaled = coverScale(input, sourceWidth, sourceHeight);
  const bytes = Buffer.alloc(COVER_HEADER_BYTES + COVER_BYTES);
  writeHeader(bytes, COVER_MAGIC);
  rgb565Pixels(scaled).copy(bytes, COVER_HEADER_BYTES);
  return { bytes, sha256: digest(bytes) };
}

export function validateCover(input: Uint8Array, expectedSha256: string): MediaMetadata {
  const bytes = byteView(input);
  if (expectedSha256 !== digest(bytes)) {
    throw new Error("The cover checksum does not match.");
  }
  if (
    bytes.length !== COVER_HEADER_BYTES + COVER_BYTES ||
    bytes.toString("ascii", 0, 4) !== COVER_MAGIC ||
    bytes.readUInt8(4) !== MEDIA_VERSION ||
    bytes.readUInt16LE(5) !== DISPLAY_WIDTH ||
    bytes.readUInt16LE(7) !== DISPLAY_HEIGHT
  ) {
    throw new Error("The cover format is invalid or unsupported.");
  }
  return { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT, sha256: expectedSha256 };
}

export { convertGifToAnimationV2InWorker } from "./animation-worker.js";
