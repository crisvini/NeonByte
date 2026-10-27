import { createHash } from "node:crypto";
import { decompressFrames, parseGIF, type ParsedFrame } from "gifuct-js";

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

function rgbaFrameToCanvas(frame: ParsedFrame, canvas: Uint8Array, width: number, height: number): void {
  const { left, top, width: frameWidth, height: frameHeight } = frame.dims;
  if (
    !Number.isInteger(left) || !Number.isInteger(top) ||
    left < 0 || top < 0 || frameWidth < 1 || frameHeight < 1 ||
    left + frameWidth > width || top + frameHeight > height ||
    frame.patch.length !== frameWidth * frameHeight * 4
  ) {
    throw new Error("The GIF contains an invalid frame and cannot be previewed.");
  }

  for (let y = 0; y < frameHeight; y += 1) {
    for (let x = 0; x < frameWidth; x += 1) {
      const patchOffset = (y * frameWidth + x) * 4;
      const targetOffset = ((top + y) * width + left + x) * 4;
      const alpha = frame.patch[patchOffset + 3] ?? 0;
      if (alpha === 0) {
        continue;
      }
      if (alpha === 255) {
        canvas[targetOffset] = frame.patch[patchOffset] ?? 0;
        canvas[targetOffset + 1] = frame.patch[patchOffset + 1] ?? 0;
        canvas[targetOffset + 2] = frame.patch[patchOffset + 2] ?? 0;
        canvas[targetOffset + 3] = 255;
        continue;
      }

      const destinationAlpha = canvas[targetOffset + 3] ?? 0;
      const outputAlpha = alpha + destinationAlpha * (1 - alpha / 255);
      for (let channel = 0; channel < 3; channel += 1) {
        const source = frame.patch[patchOffset + channel] ?? 0;
        const destination = canvas[targetOffset + channel] ?? 0;
        canvas[targetOffset + channel] = Math.round((source * alpha + destination * destinationAlpha * (1 - alpha / 255)) / outputAlpha);
      }
      canvas[targetOffset + 3] = Math.round(outputAlpha);
    }
  }
}

function clearFrame(
  canvas: Uint8Array,
  frame: ParsedFrame,
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

function writeHeader(buffer: Buffer, magic: string, frameCount?: number): void {
  buffer.write(magic, 0, 4, "ascii");
  buffer.writeUInt8(MEDIA_VERSION, 4);
  buffer.writeUInt16LE(DISPLAY_WIDTH, 5);
  buffer.writeUInt16LE(DISPLAY_HEIGHT, 7);
  if (frameCount !== undefined) {
    buffer.writeUInt16LE(frameCount, 9);
  }
}

export function convertGifToAnimation(input: Uint8Array, limits: AnimationLimits = {}): AnimationAsset {
  const maxUploadBytes = limits.maxUploadBytes ?? DEFAULT_LIMITS.maxUploadBytes;
  const maxFrames = limits.maxFrames ?? DEFAULT_LIMITS.maxFrames;
  const maxFramePixels = limits.maxFramePixels ?? DEFAULT_LIMITS.maxFramePixels;
  const maxTotalFramePixels = limits.maxTotalFramePixels ?? DEFAULT_LIMITS.maxTotalFramePixels;
  const maxDurationMs = limits.maxDurationMs ?? DEFAULT_LIMITS.maxDurationMs;
  if (input.byteLength > maxUploadBytes) {
    throw new Error(`The GIF exceeds the ${maxUploadBytes}-byte limit.`);
  }
  const signature = Buffer.from(input.subarray(0, 6)).toString("ascii");
  if (signature !== "GIF87a" && signature !== "GIF89a") {
    throw new Error("Invalid GIF: the file has no recognized GIF signature.");
  }

  try {
    const copy = Buffer.from(input);
    const gif = parseGIF(copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength));
    const width = gif.lsd.width;
    const height = gif.lsd.height;
    if (width * height > maxFramePixels) {
      throw new Error("The GIF dimensions are too large for the 240 × 240 preview.");
    }
    assertDimensions(width, height);
    const imageFrames = gif.frames.filter((frame) => "image" in frame);
    const imageFrameCount = imageFrames.length;
    if (imageFrameCount === 0) {
      throw new Error("The GIF contains no image frames.");
    }
    if (imageFrameCount > maxFrames) {
      throw new Error(`The GIF has ${imageFrameCount} frames; the animation conversion limit is ${maxFrames}. Choose a GIF with fewer frames.`);
    }

    validateGifFrameDescriptors(width, height, imageFrames.map((frame) => frame.image.descriptor), {
      maxFramePixels,
      maxTotalFramePixels,
    });

    const frames = decompressFrames(gif, true);
    const composedFrames: Array<{ pixels: Buffer; delayMs: number }> = [];
    const canvas = new Uint8Array(width * height * 4);
    let restorePrevious: Uint8Array | null = null;
    let previousFrame: ParsedFrame | null = null;
    let durationMs = 0;
    const backgroundIndex = gif.lsd.backgroundColorIndex;
    const backgroundColor = gif.gct?.[backgroundIndex] ?? null;

    for (const frame of frames) {
      if (previousFrame?.disposalType === 2) {
        const backgroundIsTransparent = previousFrame.transparentIndex === backgroundIndex;
        clearFrame(canvas, previousFrame, width, backgroundIsTransparent ? null : backgroundColor);
      } else if (previousFrame?.disposalType === 3 && restorePrevious) {
        canvas.set(restorePrevious);
      }

      const savedCanvas = frame.disposalType === 3 ? canvas.slice() : null;
      rgbaFrameToCanvas(frame, canvas, width, height);
      const delayMs = Math.max(20, frame.delay > 0 ? Math.trunc(frame.delay) : 100);
      durationMs += delayMs;
      if (durationMs > maxDurationMs) {
        throw new Error(`The animation exceeds the ${maxDurationMs} ms preview limit.`);
      }
      composedFrames.push({ pixels: rgb565Pixels(coverScale(canvas, width, height)), delayMs });
      restorePrevious = savedCanvas;
      previousFrame = frame;
    }

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
    if (error instanceof Error && /limit|dimensions|descriptor|pixels|frames|animation|preview/i.test(error.message)) {
      throw error;
    }
    throw new Error("Invalid or unsupported GIF. Choose a smaller animated GIF and try again.");
  }
}

export function validateAnimation(
  input: Uint8Array,
  expectedSha256: string,
  limits: Pick<AnimationLimits, "maxFrames" | "maxDurationMs"> = {},
): MediaMetadata {
  const bytes = Buffer.from(input);
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
  const bytes = Buffer.from(input);
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
