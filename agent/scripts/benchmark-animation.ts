import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { decompressFrames, parseGIF } from "gifuct-js";
import {
  ANIMATION_HEADER_BYTES,
  COVER_BYTES,
  convertGifToAnimation,
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
} from "../src/media/animation.js";
import { encodeAnimationV2 } from "../src/media/animation-encoder.js";

const FRAME_BYTES = COVER_BYTES;
const FRAME_COUNT = 14;
const FRAME_DELAY_MS = 70;
const FILE_HEADER_BYTES = 24;
const FRAME_DIRECTORY_BYTES = 20;
const ROW_HEADER_BYTES = 6;

type RgbColor = readonly [number, number, number];
type EncoderPolicy = "palette-only" | "rgb565-rle-delta" | "hybrid";
type RowCodec = "rgb565-raw" | "rgb565-rle" | "index-packed" | "index-rle";

export interface BenchmarkScenario {
  name: string;
  gifBytes: Buffer;
  frames: Buffer[];
  delaysMs: number[];
}

export interface BenchmarkResult {
  name: string;
  sourceGifBytes: number;
  directGifBytes: number;
  normalizedGifBytes: number;
  legacyRgb565Bytes: number;
  paletteFullBytes: number;
  rgb565RleDeltaBytes: number;
  nbifV2Bytes: number;
  legacyPixelBytesWritten: number;
  nbifV2PixelBytesWritten: number;
  legacyDisplayRows: number;
  nbifV2DisplayRows: number;
  legacySpiLowerBoundMsAt20MHz: number;
  nbifV2SpiLowerBoundMsAt20MHz: number;
  nbifV2: Buffer;
  frameCount: number;
  durationMs: number;
  changedPixels: number;
  updatedRows: number;
  reconstructedExactly: boolean;
  sourceSha256: string;
  nbifV2Sha256: string;
}

interface EncodedRow {
  y: number;
  x: number;
  width: number;
  codec: RowCodec;
  payload: Buffer;
}

interface EncodedFrame {
  kind: 0 | 1 | 2;
  indexBits: number;
  palette: number[];
  rows: EncodedRow[];
  record: Buffer;
  delayMs: number;
}

interface BitWriter {
  write(value: number, count: number): void;
  finish(): Buffer;
}

function rgb565(red: number, green: number, blue: number): number {
  return ((red >> 3) << 11) | ((green >> 2) << 5) | (blue >> 3);
}

function palette256(): RgbColor[] {
  return Array.from({ length: 256 }, (_, index) => [
    Math.round(((index >> 5) & 7) * 255 / 7),
    Math.round(((index >> 3) & 3) * 255 / 3),
    Math.round((index & 7) * 255 / 7),
  ] as const);
}

function createFrameIndexes(colorCount: number, frameCount = FRAME_COUNT): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let state = 0x7f4a7c15;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const frame = new Uint8Array(FRAME_BYTES / 2);
    for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
      for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
        let index: number;
        if (colorCount === 4) {
          index = 0;
          const objectX = 14 + (frameIndex * 12) % (DISPLAY_WIDTH - 30);
          if (x >= objectX && x < objectX + 16 && y >= 90 && y < 106) {
            index = 1 + ((x + y + frameIndex) % 3);
          }
        } else if (colorCount === 16) {
          index = (x + frameIndex * 7) & 15;
        } else if (colorCount === 64) {
          index = ((x + y + frameIndex * 3) & 63);
        } else {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          index = (state >>> 0) & 255;
        }
        frame[y * DISPLAY_WIDTH + x] = index;
      }
    }
    frames.push(frame);
  }
  return frames;
}

function createStaticIndexes(frameCount = FRAME_COUNT): Uint8Array[] {
  const first = new Uint8Array(FRAME_BYTES / 2).fill(1);
  return Array.from({ length: frameCount }, () => first.slice());
}

function bitWriter(): BitWriter {
  let accumulator = 0;
  let bitCount = 0;
  const output: number[] = [];
  return {
    write(value, count) {
      accumulator |= value << bitCount;
      bitCount += count;
      while (bitCount >= 8) {
        output.push(accumulator & 255);
        accumulator >>>= 8;
        bitCount -= 8;
      }
    },
    finish() {
      if (bitCount > 0) output.push(accumulator & 255);
      return Buffer.from(output);
    },
  };
}

function encodeGifLzw(indexes: Uint8Array, minimumCodeSize: number): Buffer {
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minimumCodeSize + 1;
  let nextCode = endCode + 1;
  let dictionary = new Map<number, number>();
  const output = bitWriter();
  const reset = () => {
    codeSize = minimumCodeSize + 1;
    nextCode = endCode + 1;
    dictionary = new Map();
  };

  output.write(clearCode, codeSize);
  if (indexes.length === 0) {
    output.write(endCode, codeSize);
    return output.finish();
  }
  let prefix = indexes[0] ?? 0;
  for (let index = 1; index < indexes.length; index += 1) {
    const symbol = indexes[index] ?? 0;
    const key = (prefix << 8) | symbol;
    const known = dictionary.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }

    output.write(prefix, codeSize);
    if (nextCode < 4096) {
      dictionary.set(key, nextCode);
      nextCode += 1;
      if (nextCode > (1 << codeSize) && codeSize < 12) codeSize += 1;
    } else {
      output.write(clearCode, codeSize);
      reset();
    }
    prefix = symbol;
  }
  output.write(prefix, codeSize);
  output.write(endCode, codeSize);
  return output.finish();
}

function gifSubBlocks(bytes: Uint8Array): Buffer {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += 255) {
    const length = Math.min(255, bytes.length - offset);
    chunks.push(Buffer.from([length]), Buffer.from(bytes.subarray(offset, offset + length)));
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function buildGif(palette: readonly RgbColor[], indexedFrames: readonly Uint8Array[], delayMs = FRAME_DELAY_MS): Buffer {
  const tableBits = Math.max(1, Math.ceil(Math.log2(Math.max(2, palette.length))));
  const tableEntries = 1 << tableBits;
  const table = Buffer.alloc(tableEntries * 3);
  for (let index = 0; index < tableEntries; index += 1) {
    const color = palette[index] ?? palette[palette.length - 1] ?? [0, 0, 0];
    table.set(color, index * 3);
  }
  const header = Buffer.alloc(13);
  header.write("GIF89a", 0, "ascii");
  header.writeUInt16LE(DISPLAY_WIDTH, 6);
  header.writeUInt16LE(DISPLAY_HEIGHT, 8);
  header[10] = 0x80 | (7 << 4) | (tableBits - 1);
  header[11] = 0;
  header[12] = 0;

  const blocks: Buffer[] = [header, table];
  for (let frameIndex = 0; frameIndex < indexedFrames.length; frameIndex += 1) {
    const frame = indexedFrames[frameIndex]!;
    if (frame.length !== DISPLAY_WIDTH * DISPLAY_HEIGHT || frame.some((index) => index >= tableEntries)) {
      throw new Error("Benchmark frame is outside the generated GIF canvas or palette.");
    }
    if (!Number.isInteger(delayMs) || delayMs % 10 !== 0 || delayMs < 0 || delayMs > 655_350) {
      throw new Error("Benchmark GIF delays must be nonnegative multiples of 10 ms within the GIF range.");
    }
    const graphicsControl = Buffer.from([0x21, 0xf9, 4, 4, 0, 0, 0, 0]);
    graphicsControl.writeUInt16LE(delayMs / 10, 4);
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(DISPLAY_WIDTH, 5);
    descriptor.writeUInt16LE(DISPLAY_HEIGHT, 7);
    const compressed = encodeGifLzw(frame, Math.max(2, tableBits));
    blocks.push(graphicsControl, descriptor, Buffer.from([Math.max(2, tableBits)]), gifSubBlocks(compressed));
  }
  blocks.push(Buffer.from([0x3b]));
  return Buffer.concat(blocks);
}

function rgb565Frames(palette: readonly RgbColor[], indexedFrames: readonly Uint8Array[]): Buffer[] {
  const convertedPalette = palette.map(([red, green, blue]) => rgb565(red, green, blue));
  return indexedFrames.map((frame) => {
    const output = Buffer.alloc(frame.length * 2);
    for (let offset = 0; offset < frame.length; offset += 1) {
      output.writeUInt16LE(convertedPalette[frame[offset] ?? 0] ?? 0, offset * 2);
    }
    return output;
  });
}

export function buildRepresentativeCorpus(): BenchmarkScenario[] {
  const colors = palette256();
  const simpleColors = [colors[0]!, colors[255]!, colors[51]!, colors[204]!];
  const scenarios = [
    { name: "static-hold-14", palette: simpleColors, frames: createStaticIndexes() },
    { name: "small-motion-14", palette: simpleColors, frames: createFrameIndexes(4) },
    { name: "full-motion-pattern-14", palette: colors.slice(0, 64), frames: createFrameIndexes(64) },
    { name: "full-motion-palette-14", palette: colors.slice(0, 16), frames: createFrameIndexes(16) },
    { name: "full-motion-noise-14", palette: colors, frames: createFrameIndexes(256) },
  ];
  return scenarios.map(({ name, palette, frames }) => ({
    name,
    gifBytes: buildGif(palette, frames),
    frames: rgb565Frames(palette, frames),
    delaysMs: Array(FRAME_COUNT).fill(FRAME_DELAY_MS) as number[],
  }));
}

export type FrameCountScenario = "static-holds" | "small-motion" | "full-motion" | "scattered-changes" | "high-entropy";

function createScatteredIndexes(frameCount: number): Uint8Array[] {
  let state = 0x6d2b79f5;
  return Array.from({ length: frameCount }, (_, frameIndex) => {
    const frame = new Uint8Array(DISPLAY_WIDTH * DISPLAY_HEIGHT);
    for (let change = 0; change < 96; change += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const pixel = (state >>> 0) % frame.length;
      frame[pixel] = 1 + ((frameIndex + change) % 3);
    }
    return frame;
  });
}

export function buildFrameCountFixture(
  frameCount: number,
  scenario: FrameCountScenario,
  delayMs = 40,
): BenchmarkScenario {
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 61) {
    throw new RangeError("Benchmark fixtures support 1 to 61 frames.");
  }
  const colors = palette256();
  const palette = scenario === "high-entropy" ? colors
    : scenario === "full-motion" ? colors.slice(0, 64)
      : [colors[0]!, colors[255]!, colors[51]!, colors[204]!];
  const indexedFrames = scenario === "static-holds" ? createStaticIndexes(frameCount)
    : scenario === "small-motion" ? createFrameIndexes(4, frameCount)
      : scenario === "full-motion" ? createFrameIndexes(64, frameCount)
        : scenario === "scattered-changes" ? createScatteredIndexes(frameCount)
          : createFrameIndexes(256, frameCount);
  const frames = rgb565Frames(palette, indexedFrames);
  return {
    name: `${scenario}-${frameCount}`,
    gifBytes: buildGif(palette, indexedFrames, delayMs),
    frames,
    delaysMs: Array(frameCount).fill(delayMs) as number[],
  };
}

function uniquePalette(frame: Buffer): { colors: number[]; lookup: Map<number, number> } | null {
  const colors: number[] = [];
  const lookup = new Map<number, number>();
  for (let offset = 0; offset < FRAME_BYTES; offset += 2) {
    const color = frame.readUInt16LE(offset);
    if (!lookup.has(color)) {
      if (colors.length === 256) return null;
      lookup.set(color, colors.length);
      colors.push(color);
    }
  }
  return { colors, lookup };
}

function indexBits(count: number): number {
  if (count <= 2) return 1;
  if (count <= 4) return 2;
  if (count <= 16) return 4;
  return 8;
}

function encodeRle(values: readonly number[], bytesPerValue: 1 | 2): Buffer {
  const output: number[] = [];
  let cursor = 0;
  const emitValue = (value: number) => {
    output.push(value & 255);
    if (bytesPerValue === 2) output.push((value >>> 8) & 255);
  };
  while (cursor < values.length) {
    let repeat = 1;
    while (cursor + repeat < values.length && repeat < 128 && values[cursor + repeat] === values[cursor]) repeat += 1;
    if (repeat >= 3) {
      output.push(0x80 | (repeat - 1));
      emitValue(values[cursor] ?? 0);
      cursor += repeat;
      continue;
    }
    const literalStart = cursor;
    cursor += repeat;
    while (cursor < values.length && cursor - literalStart < 128) {
      let nextRepeat = 1;
      while (cursor + nextRepeat < values.length && nextRepeat < 128 && values[cursor + nextRepeat] === values[cursor]) nextRepeat += 1;
      if (nextRepeat >= 3) break;
      cursor += Math.min(nextRepeat, 128 - (cursor - literalStart));
    }
    output.push(cursor - literalStart - 1);
    for (let index = literalStart; index < cursor; index += 1) emitValue(values[index] ?? 0);
  }
  return Buffer.from(output);
}

function packIndexes(indexes: readonly number[], bits: number): Buffer {
  const output = Buffer.alloc(Math.ceil(indexes.length * bits / 8));
  let bitOffset = 0;
  for (const value of indexes) {
    const shift = 8 - bits - (bitOffset & 7);
    output[bitOffset >> 3] = (output[bitOffset >> 3] ?? 0) | (value << shift);
    bitOffset += bits;
  }
  return output;
}

function bestRow(frame: Buffer, y: number, x: number, width: number,
                 palette: { colors: number[]; lookup: Map<number, number> } | null,
                 policy: EncoderPolicy): EncodedRow {
  const firstPixel = y * DISPLAY_WIDTH + x;
  const rgb565Values = Array.from({ length: width }, (_, offset) => frame.readUInt16LE((firstPixel + offset) * 2));
  const raw = Buffer.alloc(width * 2);
  for (let offset = 0; offset < width; offset += 1) raw.writeUInt16LE(rgb565Values[offset] ?? 0, offset * 2);
  const candidates: EncodedRow[] = [{ y, x, width, codec: "rgb565-raw", payload: raw }];

  if (policy !== "palette-only") {
    const rle = encodeRle(rgb565Values, 2);
    if (rle.length < raw.length) candidates.push({ y, x, width, codec: "rgb565-rle", payload: rle });
  }
  if (palette) {
    const indexes = rgb565Values.map((color) => palette.lookup.get(color) ?? 0);
    const packed = packIndexes(indexes, indexBits(palette.colors.length));
    candidates.push({ y, x, width, codec: "index-packed", payload: packed });
    if (policy !== "palette-only") {
      const rle = encodeRle(indexes, 1);
      if (rle.length < packed.length) candidates.push({ y, x, width, codec: "index-rle", payload: rle });
    }
  }
  candidates.sort((left, right) => left.payload.length - right.payload.length ||
    ["index-packed", "rgb565-raw", "index-rle", "rgb565-rle"].indexOf(left.codec) -
    ["index-packed", "rgb565-raw", "index-rle", "rgb565-rle"].indexOf(right.codec));
  return candidates[0]!;
}

function changedBounds(frame: Buffer, previous: Buffer, y: number): [number, number] | null {
  let first = DISPLAY_WIDTH;
  let last = -1;
  const rowStart = y * DISPLAY_WIDTH * 2;
  for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
    const offset = rowStart + x * 2;
    if (frame[offset] !== previous[offset] || frame[offset + 1] !== previous[offset + 1]) {
      first = Math.min(first, x);
      last = x;
    }
  }
  return last < 0 ? null : [first, last];
}

function encodeRows(frame: Buffer, previous: Buffer | null, palette: ReturnType<typeof uniquePalette>, policy: EncoderPolicy) {
  const keyRows: EncodedRow[] = [];
  const deltaRows: EncodedRow[] = [];
  let changedPixels = 0;
  for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
    keyRows.push(bestRow(frame, y, 0, DISPLAY_WIDTH, palette, policy));
    if (!previous) continue;
    const bounds = changedBounds(frame, previous, y);
    if (!bounds) continue;
    const [first, last] = bounds;
    const spanWidth = last - first + 1;
    changedPixels += spanWidth;
    deltaRows.push(bestRow(frame, y, first, spanWidth, palette, policy));
  }
  return { keyRows, deltaRows, changedPixels };
}

function serializeRow(row: EncodedRow): Buffer {
  const header = Buffer.alloc(ROW_HEADER_BYTES);
  header[0] = row.y;
  header[1] = row.x;
  header[2] = row.width;
  header[3] = ["rgb565-raw", "rgb565-rle", "index-packed", "index-rle"].indexOf(row.codec);
  header.writeUInt16LE(row.payload.length, 4);
  return Buffer.concat([header, row.payload]);
}

function serializeCandidate(frames: readonly EncodedFrame[], policy: EncoderPolicy): Buffer {
  const directoryBytes = frames.length * FRAME_DIRECTORY_BYTES;
  const recordsStart = FILE_HEADER_BYTES + directoryBytes;
  const recordOffsets: number[] = [];
  let cursor = recordsStart;
  for (const frame of frames) {
    recordOffsets.push(cursor);
    cursor += frame.record.length;
  }
  const file = Buffer.alloc(cursor);
  file.write("NBIF", 0, "ascii");
  file[4] = 2;
  file[5] = 0;
  file.writeUInt16LE(DISPLAY_WIDTH, 6);
  file.writeUInt16LE(DISPLAY_HEIGHT, 8);
  file.writeUInt16LE(frames.length, 10);
  file.writeUInt32LE(frames.reduce((total, frame) => total + frame.delayMs, 0), 12);
  file.writeUInt32LE(file.length, 16);
  file.writeUInt32LE(0, 20);
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!;
    const offset = FILE_HEADER_BYTES + index * FRAME_DIRECTORY_BYTES;
    file.writeUInt32LE(recordOffsets[index]!, offset);
    file.writeUInt32LE(frame.record.length, offset + 4);
    file.writeUInt16LE(frame.delayMs, offset + 8);
    file[offset + 10] = frame.kind;
    file[offset + 11] = frame.indexBits;
    file.writeUInt16LE(frame.palette.length, offset + 12);
    file.writeUInt16LE(frame.rows.length, offset + 14);
    file.writeUInt32LE(0, offset + 16);
    frame.record.copy(file, recordOffsets[index]!);
  }
  if (policy === "palette-only" && frames.some((frame) => frame.kind !== 0)) {
    throw new Error("Palette-only benchmark must encode every frame as a keyframe.");
  }
  return file;
}

function encodeCandidate(frames: readonly Buffer[], delaysMs: readonly number[], policy: EncoderPolicy): Buffer {
  const encodedFrames: EncodedFrame[] = [];
  let previous: Buffer | null = null;
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex]!;
    const palette = policy === "rgb565-rle-delta" ? null : uniquePalette(frame);
    const { keyRows, deltaRows } = encodeRows(frame, previous, palette, policy);
    const paletteBytes = palette ? Buffer.alloc(palette.colors.length * 2) : Buffer.alloc(0);
    palette?.colors.forEach((color, index) => paletteBytes.writeUInt16LE(color, index * 2));
    const rowsToBytes = (rows: EncodedRow[]) => Buffer.concat([paletteBytes, ...rows.map(serializeRow)]);
    const keyRecord = rowsToBytes(keyRows);
    const canDelta = policy !== "palette-only" && previous !== null;
    const deltaRecord = rowsToBytes(deltaRows);
    const useHold = canDelta && deltaRows.length === 0;
    const useDelta = canDelta && (useHold || deltaRecord.length < keyRecord.length);
    const rows = useDelta ? deltaRows : keyRows;
    const record = useHold ? Buffer.alloc(0) : useDelta ? deltaRecord : keyRecord;
    encodedFrames.push({
      kind: useHold ? 2 : useDelta ? 1 : 0,
      indexBits: palette ? indexBits(palette.colors.length) : 0,
      palette: useHold ? [] : palette?.colors ?? [],
      rows,
      record,
      delayMs: delaysMs[frameIndex]!,
    });
    previous = frame;
  }
  return serializeCandidate(encodedFrames, policy);
}

interface CandidateDecoded {
  frames: Buffer[];
  delaysMs: number[];
  durationMs: number;
}

export function decodeBenchmarkNbifV2(bytes: Buffer): CandidateDecoded {
  if (bytes.length < FILE_HEADER_BYTES || bytes.toString("ascii", 0, 4) !== "NBIF" || bytes[4] !== 2) {
    throw new Error("Benchmark NBIF v2 header is invalid.");
  }
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  const frameCount = bytes.readUInt16LE(10);
  if (width !== DISPLAY_WIDTH || height !== DISPLAY_HEIGHT || frameCount < 1 || frameCount > 20 || bytes.readUInt32LE(16) !== bytes.length) {
    throw new Error("Benchmark NBIF v2 dimensions, frame count, or length is invalid.");
  }

  const frames: Buffer[] = [];
  const delaysMs: number[] = [];
  let totalDuration = 0;
  for (let index = 0; index < frameCount; index += 1) {
    const directoryOffset = FILE_HEADER_BYTES + index * FRAME_DIRECTORY_BYTES;
    if (directoryOffset + FRAME_DIRECTORY_BYTES > bytes.length) throw new Error("Benchmark NBIF v2 directory is truncated.");
    const recordOffset = bytes.readUInt32LE(directoryOffset);
    const recordLength = bytes.readUInt32LE(directoryOffset + 4);
    const delayMs = bytes.readUInt16LE(directoryOffset + 8);
    const kind = bytes[directoryOffset + 10];
    const bits = bytes[directoryOffset + 11];
    const paletteCount = bytes.readUInt16LE(directoryOffset + 12);
    const rowCount = bytes.readUInt16LE(directoryOffset + 14);
    if (recordOffset + recordLength > bytes.length || delayMs < 20 || (kind !== 0 && kind !== 1 && kind !== 2)) {
      throw new Error("Benchmark NBIF v2 frame bounds or timing is invalid.");
    }
    totalDuration += delayMs;
    if (totalDuration > 30_000) throw new Error("Benchmark NBIF v2 duration exceeds its limit.");

    const frame = kind === 1 ? Buffer.from(frames[index - 1]!) :
      kind === 2 ? Buffer.from(frames[index - 1]!) : Buffer.alloc(FRAME_BYTES);
    let cursor = recordOffset;
    const end = recordOffset + recordLength;
    const palette: number[] = [];
    for (let paletteIndex = 0; paletteIndex < paletteCount; paletteIndex += 1) {
      if (cursor + 2 > end) throw new Error("Benchmark NBIF v2 palette is truncated.");
      palette.push(bytes.readUInt16LE(cursor));
      cursor += 2;
    }
    if (kind === 2 && (paletteCount !== 0 || rowCount !== 0 || recordLength !== 0)) {
      throw new Error("Benchmark NBIF v2 hold frame is not empty.");
    }
    for (let row = 0; row < rowCount; row += 1) {
      if (cursor + ROW_HEADER_BYTES > end) throw new Error("Benchmark NBIF v2 row header is truncated.");
      const y = bytes[cursor++]!;
      const x = bytes[cursor++]!;
      const spanWidth = bytes[cursor++]!;
      const codec = bytes[cursor++]!;
      const encodedBytes = bytes.readUInt16LE(cursor);
      cursor += 2;
      if (spanWidth < 1 || x + spanWidth > width || y >= height || cursor + encodedBytes > end) {
        throw new Error("Benchmark NBIF v2 row bounds are invalid.");
      }
      const payloadEnd = cursor + encodedBytes;
      const values: number[] = [];
      const bytesPerValue = codec === 0 || codec === 1 ? 2 : 1;
      if (codec === 0) {
        while (cursor < payloadEnd) {
          if (cursor + 2 > payloadEnd) throw new Error("Benchmark NBIF v2 raw RGB565 value is truncated.");
          values.push(bytes.readUInt16LE(cursor));
          cursor += 2;
        }
      } else if (codec === 2) {
        if (bits !== 1 && bits !== 2 && bits !== 4 && bits !== 8) throw new Error("Benchmark NBIF v2 index depth is invalid.");
        const payloadStart = cursor;
        if (Math.ceil(spanWidth * bits / 8) !== encodedBytes) throw new Error("Benchmark NBIF v2 packed index length is invalid.");
        for (let pixel = 0; pixel < spanWidth; pixel += 1) {
          const bit = pixel * bits;
          const shift = 8 - bits - (bit & 7);
          const paletteIndex = ((bytes[payloadStart + (bit >> 3)] ?? 0) >> shift) & ((1 << bits) - 1);
          if (paletteIndex >= palette.length) throw new Error("Benchmark NBIF v2 palette index is invalid.");
          values.push(palette[paletteIndex]!);
        }
        cursor = payloadEnd;
      } else if (codec === 1 || codec === 3) {
        const indexBitsPerValue = bytesPerValue;
        while (cursor < payloadEnd) {
          const control = bytes[cursor++]!;
          const count = (control & 0x7f) + 1;
          if (control & 0x80) {
            if (cursor + indexBitsPerValue > payloadEnd) throw new Error("Benchmark NBIF v2 RLE value is truncated.");
            const value = indexBitsPerValue === 2 ? bytes.readUInt16LE(cursor) : bytes[cursor]!;
            cursor += indexBitsPerValue;
            for (let repeat = 0; repeat < count; repeat += 1) values.push(value);
          } else {
            const bytesNeeded = count * indexBitsPerValue;
            if (cursor + bytesNeeded > payloadEnd) throw new Error("Benchmark NBIF v2 RLE literal is truncated.");
            for (let literal = 0; literal < count; literal += 1) {
              values.push(indexBitsPerValue === 2 ? bytes.readUInt16LE(cursor) : bytes[cursor]!);
              cursor += indexBitsPerValue;
            }
          }
        }
        if (codec === 3) {
          for (let pixel = 0; pixel < values.length; pixel += 1) {
            const paletteIndex = values[pixel]!;
            if (paletteIndex >= palette.length) throw new Error("Benchmark NBIF v2 palette index is invalid.");
            values[pixel] = palette[paletteIndex]!;
          }
        }
      } else {
        throw new Error("Benchmark NBIF v2 row codec is unknown.");
      }
      if (values.length !== spanWidth || cursor !== payloadEnd) throw new Error("Benchmark NBIF v2 row length is invalid.");
      const rowOffset = (y * width + x) * 2;
      values.forEach((value, pixel) => frame.writeUInt16LE(value, rowOffset + pixel * 2));
      cursor = payloadEnd;
    }
    if (cursor !== end || (kind === 0 && rowCount !== height)) throw new Error("Benchmark NBIF v2 frame is incomplete.");
    if (index === 0 && kind !== 0) throw new Error("Benchmark NBIF v2 must start with a keyframe.");
    frames.push(frame);
    delaysMs.push(delayMs);
  }
  return { frames, delaysMs, durationMs: totalDuration };
}

function countChangedPixels(frames: readonly Buffer[]): number {
  let changed = 0;
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1]!;
    const current = frames[index]!;
    for (let offset = 0; offset < FRAME_BYTES; offset += 2) {
      if (previous[offset] !== current[offset] || previous[offset + 1] !== current[offset + 1]) changed += 1;
    }
  }
  return changed;
}

function verifyAgainstGif(scenario: BenchmarkScenario, legacyFrames: readonly Buffer[]): boolean {
  const parsed = parseGIF(scenario.gifBytes.buffer.slice(
    scenario.gifBytes.byteOffset,
    scenario.gifBytes.byteOffset + scenario.gifBytes.byteLength,
  ));
  const decoded = decompressFrames(parsed, true).filter((_, index) => index < legacyFrames.length);
  if (decoded.length !== legacyFrames.length) return false;
  return decoded.every((frame, index) => {
    const pixels = legacyFrames[index]!;
    const colors = parsed.gct ?? [];
    const { width, height } = frame.dims;
    if (width !== DISPLAY_WIDTH || height !== DISPLAY_HEIGHT || frame.patch.length !== width * height * 4) return false;
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const rgba = pixel * 4;
      const actual = rgb565(frame.patch[rgba] ?? 0, frame.patch[rgba + 1] ?? 0, frame.patch[rgba + 2] ?? 0);
      if (pixels.readUInt16LE(pixel * 2) !== actual) return false;
      if (!colors.length) return false;
    }
    return true;
  });
}

export function benchmarkScenario(scenario: BenchmarkScenario): BenchmarkResult {
  const legacy = convertGifToAnimation(scenario.gifBytes);
  const legacyFrames = Array.from({ length: legacy.frameCount }, (_, index) => {
    const offset = ANIMATION_HEADER_BYTES + index * (2 + FRAME_BYTES) + 2;
    return legacy.bytes.subarray(offset, offset + FRAME_BYTES);
  });
  const paletteFull = encodeCandidate(legacyFrames, scenario.delaysMs, "palette-only");
  const rgb565RleDelta = encodeCandidate(legacyFrames, scenario.delaysMs, "rgb565-rle-delta");
  const nbifV2 = encodeAnimationV2(legacyFrames.map((pixels, index) => ({ pixels, delayMs: scenario.delaysMs[index]! }))).bytes;
  const decoded = decodeBenchmarkNbifV2(nbifV2);
  const changedPixels = countChangedPixels(legacyFrames);
  let updatedRows = 0;
  let totalRowSpans = 0;
  let nbifV2PixelBytesWritten = 0;
  for (let frameIndex = 0; frameIndex < decoded.frames.length; frameIndex += 1) {
    const directoryOffset = FILE_HEADER_BYTES + frameIndex * FRAME_DIRECTORY_BYTES;
    const kind = nbifV2[directoryOffset + 10];
    const recordOffset = nbifV2.readUInt32LE(directoryOffset);
    let cursor = recordOffset + nbifV2.readUInt16LE(directoryOffset + 12) * 2;
    const rowCount = nbifV2.readUInt16LE(directoryOffset + 14);
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const y = nbifV2[cursor]!;
      const width = nbifV2[cursor + 2]!;
      const payloadLength = nbifV2.readUInt16LE(cursor + 4);
      nbifV2PixelBytesWritten += width * 2;
      totalRowSpans += 1;
      if (kind !== 0) updatedRows += 1;
      cursor += ROW_HEADER_BYTES + payloadLength;
      void y;
    }
  }
  const legacyPixelBytesWritten = decoded.frames.length * FRAME_BYTES;
  const nbifV2DisplayRows = totalRowSpans;
  const legacyDisplayRows = decoded.frames.length * DISPLAY_HEIGHT;
  const legacyRgb565Bytes = legacy.bytes.length;
  const directGifBytes = scenario.gifBytes.length;
  return {
    name: scenario.name,
    sourceGifBytes: directGifBytes,
    directGifBytes,
    normalizedGifBytes: directGifBytes,
    legacyRgb565Bytes,
    paletteFullBytes: paletteFull.length,
    rgb565RleDeltaBytes: rgb565RleDelta.length,
    nbifV2Bytes: nbifV2.length,
    legacyPixelBytesWritten,
    nbifV2PixelBytesWritten,
    legacyDisplayRows,
    nbifV2DisplayRows,
    legacySpiLowerBoundMsAt20MHz: legacyPixelBytesWritten * 8 * 1000 / 20_000_000,
    nbifV2SpiLowerBoundMsAt20MHz: nbifV2PixelBytesWritten * 8 * 1000 / 20_000_000,
    nbifV2,
    frameCount: legacy.frameCount,
    durationMs: legacy.durationMs,
    changedPixels,
    updatedRows,
    reconstructedExactly: verifyAgainstGif(scenario, legacyFrames) && decoded.frames.every((frame, index) => frame.equals(legacyFrames[index]!)),
    sourceSha256: createHash("sha256").update(scenario.gifBytes).digest("hex"),
    nbifV2Sha256: createHash("sha256").update(nbifV2).digest("hex"),
  };
}

export interface DecodedBenchmarkAnimation {
  frames: Buffer[];
  delaysMs: number[];
  durationMs: number;
}

function gifFramesToRgb565(gifBytes: Buffer): Buffer[] {
  const parsed = parseGIF(gifBytes.buffer.slice(gifBytes.byteOffset, gifBytes.byteOffset + gifBytes.byteLength));
  return decompressFrames(parsed, true).map((frame) => {
    const result = Buffer.alloc(frame.patch.length / 2);
    for (let pixel = 0; pixel < frame.patch.length / 4; pixel += 1) {
      const source = pixel * 4;
      result.writeUInt16LE(rgb565(frame.patch[source] ?? 0, frame.patch[source + 1] ?? 0, frame.patch[source + 2] ?? 0), pixel * 2);
    }
    return result;
  });
}

export { gifFramesToRgb565 };

function markdownReport(results: readonly BenchmarkResult[]): string {
  const header = [
    "# Animation Codec Benchmark",
    "",
    "Generated GIF fixtures use 14 full-canvas 240 x 240 frames at 70 ms each. The reference GIF was not supplied. This is a synthetic benchmark; full-motion noise is a worst-case fallback check.",
    "",
    "Sizes are encoded file bytes. RAM and timing are not inferred from host measurements. The direct GIF row measures storage only; the ESP8266 has no GIF decoder in the current build.",
    "",
    "The SPI columns are pixel-only lower bounds at the current requested 20 MHz clock. They exclude address commands, scheduling, decoder and LittleFS work. A display-row iteration is an estimate from the current one-row-per-loop renderer, not a measured FPS result.",
    "",
    "| Scenario | Source GIF | Source SHA-256 | NBIF v1 RGB565 | Palette full frames | RGB565 RLE + delta | NBIF v2 | NBIF v2 SHA-256 | Reduction vs v1 | Exact | Changed pixels | V2 rows / V1 rows | V2 pixel bytes | SPI lower bound V2 / V1 |",
    "|---|---:|---|---:|---:|---:|---:|---|---:|---|---:|---:|---:|---:|",
  ];
  const rows = results.map((result) => `| ${result.name} | ${result.sourceGifBytes} | ${result.sourceSha256} | ${result.legacyRgb565Bytes} | ${result.paletteFullBytes} | ${result.rgb565RleDeltaBytes} | ${result.nbifV2Bytes} | ${result.nbifV2Sha256} | ${(100 * (1 - result.nbifV2Bytes / result.legacyRgb565Bytes)).toFixed(2)}% | ${result.reconstructedExactly} | ${result.changedPixels} | ${result.nbifV2DisplayRows} / ${result.legacyDisplayRows} | ${result.nbifV2PixelBytesWritten} | ${result.nbifV2SpiLowerBoundMsAt20MHz.toFixed(2)} / ${result.legacySpiLowerBoundMsAt20MHz.toFixed(2)} ms |`);
  return [...header, ...rows, "", "Decoder comparison: direct GIF retains the smallest source bytes but needs an MCU LZW decoder. Upstream AnimatedGIF documents roughly 22 KiB for its no-framebuffer path; no target build or physical timing is included here.", ""].join("\n");
}

export function runAnimationBenchmark(): BenchmarkResult[] {
  return buildRepresentativeCorpus().map(benchmarkScenario);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const results = runAnimationBenchmark();
  const report = process.argv.includes("--json")
    ? JSON.stringify(results.map(({ nbifV2, ...metadata }) => metadata), null, 2)
    : markdownReport(results);
  if (process.argv.includes("--output")) {
    const index = process.argv.indexOf("--output");
    const path = process.argv[index + 1];
    if (!path) throw new Error("--output requires a path.");
    await writeFile(path, report, "utf8");
  } else {
    process.stdout.write(report);
  }
}
