import { createHash } from "node:crypto";
import {
  AnimationFrameKind,
  AnimationRowCodec,
  NBIF_FRAME_BYTES,
  NBIF_HEIGHT,
  NBIF_V2_DIRECTORY_ENTRY_BYTES,
  NBIF_V2_HEADER_BYTES,
  NBIF_V2_MAX_DURATION_MS,
  NBIF_V2_MAX_FILE_BYTES,
  NBIF_V2_MAX_FRAMES,
  NBIF_V2_ROW_HEADER_BYTES,
  NBIF_WIDTH,
  type AnimationDirectoryEntry,
  type AnimationV2Metadata,
} from "./animation-format.js";

export interface DecodedAnimationV2 {
  metadata: AnimationV2Metadata;
  frames: Buffer[];
  delaysMs: number[];
}

function fail(message: string): never {
  throw new Error(`NBIF v2 ${message}.`);
}

function byteView(input: Uint8Array): Buffer {
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

function readDirectory(bytes: Buffer, count: number): AnimationDirectoryEntry[] {
  const directory: AnimationDirectoryEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = NBIF_V2_HEADER_BYTES + index * NBIF_V2_DIRECTORY_ENTRY_BYTES;
    directory.push({
      recordOffset: bytes.readUInt32LE(offset),
      recordBytes: bytes.readUInt32LE(offset + 4),
      delayMs: bytes.readUInt16LE(offset + 8),
      kind: bytes[offset + 10] as AnimationFrameKind,
      indexBits: bytes[offset + 11] ?? 0,
      paletteCount: bytes.readUInt16LE(offset + 12),
      rowCount: bytes.readUInt16LE(offset + 14),
    });
    if (bytes.readUInt32LE(offset + 16) !== 0) fail("directory reserved field is nonzero");
  }
  return directory;
}

function expectedBits(paletteCount: number): number {
  if (paletteCount <= 2) return 1;
  if (paletteCount <= 4) return 2;
  if (paletteCount <= 16) return 4;
  return 8;
}

function unpackPalette(bytes: Buffer, entry: AnimationDirectoryEntry): { colors: number[]; offset: number } {
  if (entry.paletteCount === 0) {
    if (entry.indexBits !== 0) fail("has index bits without a palette");
    return { colors: [], offset: entry.recordOffset };
  }
  if (entry.paletteCount > 256 || entry.indexBits !== expectedBits(entry.paletteCount)) fail("palette size or index width is invalid");
  const paletteBytes = entry.paletteCount * 2;
  if (paletteBytes > entry.recordBytes) fail("palette exceeds its frame record");
  const colors: number[] = [];
  const unique = new Set<number>();
  for (let index = 0; index < entry.paletteCount; index += 1) {
    const color = bytes.readUInt16LE(entry.recordOffset + index * 2);
    if (unique.has(color)) fail("palette contains duplicate RGB565 colors");
    unique.add(color);
    colors.push(color);
  }
  return { colors, offset: entry.recordOffset + paletteBytes };
}

function decodeRle(payload: Buffer, width: number, palette: readonly number[] | null, bytesPerValue: 1 | 2): Buffer {
  const output = Buffer.alloc(width * 2);
  let input = 0;
  let pixels = 0;
  const writeValue = (target: number, value: number) => {
    if (bytesPerValue === 1) {
      if (!palette || value >= palette.length) fail("contains an invalid palette index");
      output.writeUInt16LE(palette[value]!, target * 2);
    } else output.writeUInt16LE(value, target * 2);
  };
  while (input < payload.length) {
    const control = payload[input++]!;
    const count = (control & 0x7f) + 1;
    if (pixels + count > width) fail("RLE output exceeds its row width");
    if (control & 0x80) {
      const valueBytes = bytesPerValue;
      if (input + valueBytes > payload.length) fail("RLE repeat value is incomplete");
      const value = bytesPerValue === 1 ? payload[input]! : payload.readUInt16LE(input);
      input += valueBytes;
      for (let index = 0; index < count; index += 1) writeValue(pixels++, value);
    } else {
      const inputBytes = count * bytesPerValue;
      if (input + inputBytes > payload.length) fail("RLE literal is incomplete");
      for (let index = 0; index < count; index += 1) {
        const value = bytesPerValue === 1 ? payload[input]! : payload.readUInt16LE(input);
        input += bytesPerValue;
        writeValue(pixels++, value);
      }
    }
  }
  if (pixels !== width) fail("RLE output does not match its row width");
  return output;
}

function decodePacked(payload: Buffer, width: number, bits: number, palette: readonly number[]): Buffer {
  const expectedBytes = Math.ceil(width * bits / 8);
  if (payload.length !== expectedBytes) fail("packed index length is invalid");
  const output = Buffer.alloc(width * 2);
  let bitOffset = 0;
  for (let pixel = 0; pixel < width; pixel += 1) {
    let index = 0;
    for (let bit = 0; bit < bits; bit += 1) {
      index = (index << 1) | ((payload[bitOffset >> 3]! >> (7 - (bitOffset & 7))) & 1);
      bitOffset += 1;
    }
    if (index >= palette.length) fail("packed row contains an invalid palette index");
    output.writeUInt16LE(palette[index]!, pixel * 2);
  }
  const usedBits = width * bits;
  const paddingBits = payload.length * 8 - usedBits;
  if (paddingBits > 0 && (payload[payload.length - 1]! & ((1 << paddingBits) - 1)) !== 0) fail("packed row padding is nonzero");
  return output;
}

function decodeRows(
  bytes: Buffer,
  entry: AnimationDirectoryEntry,
  colors: readonly number[],
  rowOffset: number,
  frame: Buffer,
): void {
  let cursor = rowOffset;
  let previousY = -1;
  for (let rowIndex = 0; rowIndex < entry.rowCount; rowIndex += 1) {
    if (cursor + NBIF_V2_ROW_HEADER_BYTES > entry.recordOffset + entry.recordBytes) fail("row header exceeds its frame record");
    const y = bytes[cursor]!;
    const x = bytes[cursor + 1]!;
    const width = bytes[cursor + 2]!;
    const codec = bytes[cursor + 3]! as AnimationRowCodec;
    const encodedBytes = bytes.readUInt16LE(cursor + 4);
    cursor += NBIF_V2_ROW_HEADER_BYTES;
    if (y <= previousY || y >= NBIF_HEIGHT || width < 1 || width > NBIF_WIDTH || x + width > NBIF_WIDTH) fail("row coordinates or ordering are invalid");
    previousY = y;
    if (cursor + encodedBytes > entry.recordOffset + entry.recordBytes) fail("row payload exceeds its frame record");
    const payload = bytes.subarray(cursor, cursor + encodedBytes);
    cursor += encodedBytes;
    let decoded: Buffer;
    switch (codec) {
      case AnimationRowCodec.Rgb565Raw:
        if (encodedBytes !== width * 2) fail("raw RGB565 row length is invalid");
        decoded = payload;
        break;
      case AnimationRowCodec.Rgb565Rle:
        decoded = decodeRle(payload, width, null, 2);
        break;
      case AnimationRowCodec.PackedIndices:
        if (colors.length === 0) fail("uses a packed row without a palette");
        decoded = decodePacked(payload, width, entry.indexBits, colors);
        break;
      case AnimationRowCodec.IndexedRle:
        if (colors.length === 0) fail("uses indexed RLE without a palette");
        decoded = decodeRle(payload, width, colors, 1);
        break;
      default:
        fail("uses an unknown row codec");
    }
    decoded.copy(frame, (y * NBIF_WIDTH + x) * 2);
  }
  if (cursor !== entry.recordOffset + entry.recordBytes) fail("frame record contains trailing or missing row data");
  if (entry.kind === AnimationFrameKind.Keyframe) {
    if (entry.rowCount !== NBIF_HEIGHT) fail("keyframe does not contain every row");
    for (let y = 0; y < NBIF_HEIGHT; y += 1) {
      let cursor = rowOffset;
      for (let index = 0; index < y; index += 1) cursor += NBIF_V2_ROW_HEADER_BYTES + bytes.readUInt16LE(cursor + 4);
      if (bytes[cursor] !== y || bytes[cursor + 1] !== 0 || bytes[cursor + 2] !== NBIF_WIDTH) fail("keyframe row does not cover the full canvas");
    }
  }
}

function inspectAnimationV2(bytes: Buffer): { metadata: AnimationV2Metadata; directory: AnimationDirectoryEntry[] } {
  if (bytes.length < NBIF_V2_HEADER_BYTES || bytes.toString("ascii", 0, 4) !== "NBIF" || bytes[4] !== 2) fail("header is invalid or unsupported");
  if (bytes[5] !== 0 || bytes.readUInt32LE(20) !== 0) fail("header flags or reserved field are invalid");
  if (bytes.readUInt16LE(6) !== NBIF_WIDTH || bytes.readUInt16LE(8) !== NBIF_HEIGHT) fail("dimensions are invalid");
  const frameCount = bytes.readUInt16LE(10);
  const durationMs = bytes.readUInt32LE(12);
  const fileBytes = bytes.readUInt32LE(16);
  if (frameCount < 1 || frameCount > NBIF_V2_MAX_FRAMES) fail("frame count is outside the allowed range");
  if (fileBytes !== bytes.length || fileBytes > NBIF_V2_MAX_FILE_BYTES || fileBytes < NBIF_V2_HEADER_BYTES + frameCount * NBIF_V2_DIRECTORY_ENTRY_BYTES) fail("file size is invalid");
  const directory = readDirectory(bytes, frameCount);
  let expectedOffset = NBIF_V2_HEADER_BYTES + frameCount * NBIF_V2_DIRECTORY_ENTRY_BYTES;
  let summedDuration = 0;
  for (let index = 0; index < directory.length; index += 1) {
    const entry = directory[index]!;
    if (entry.recordOffset !== expectedOffset || entry.recordBytes > bytes.length - entry.recordOffset) fail("directory offsets are not contiguous or bounded");
    if (entry.delayMs < 20) fail("frame delay is below 20 ms");
    if (entry.kind < AnimationFrameKind.Keyframe || entry.kind > AnimationFrameKind.Hold) fail("frame kind is unknown");
    if (index === 0 && entry.kind !== AnimationFrameKind.Keyframe) fail("first frame is not a keyframe");
    if (entry.kind === AnimationFrameKind.Hold) {
      if (entry.recordBytes !== 0 || entry.rowCount !== 0 || entry.paletteCount !== 0 || entry.indexBits !== 0) fail("hold frame is not empty");
    } else {
      if (entry.rowCount < 1 || entry.rowCount > NBIF_HEIGHT) fail("row count is invalid");
      if (entry.kind === AnimationFrameKind.Keyframe && entry.rowCount !== NBIF_HEIGHT) fail("keyframe row count is incomplete");
      if (entry.recordBytes < entry.paletteCount * 2 + entry.rowCount * NBIF_V2_ROW_HEADER_BYTES) fail("frame record is too short");
    }
    expectedOffset += entry.recordBytes;
    summedDuration += entry.delayMs;
  }
  if (expectedOffset !== bytes.length || summedDuration !== durationMs || durationMs > NBIF_V2_MAX_DURATION_MS) fail("directory totals do not match the file header");

  return {
    directory,
    metadata: { width: NBIF_WIDTH, height: NBIF_HEIGHT, frameCount, durationMs, fileBytes, directory },
  };
}

export function decodeAnimationV2(input: Uint8Array): DecodedAnimationV2 {
  const bytes = byteView(input);
  const { metadata, directory } = inspectAnimationV2(bytes);
  const frames: Buffer[] = [];
  for (const entry of directory) {
    if (entry.kind === AnimationFrameKind.Hold && frames.length === 0) fail("hold has no preceding frame");
    const frame = entry.kind === AnimationFrameKind.Keyframe ? Buffer.alloc(NBIF_FRAME_BYTES) : Buffer.from(frames[frames.length - 1]!);
    if (entry.kind !== AnimationFrameKind.Hold) {
      const { colors, offset } = unpackPalette(bytes, entry);
      decodeRows(bytes, entry, colors, offset, frame);
    }
    frames.push(frame);
  }
  return { metadata, frames, delaysMs: directory.map((entry) => entry.delayMs) };
}

export function validateAnimationV2(input: Uint8Array, expectedSha256?: string): AnimationV2Metadata {
  const bytes = byteView(input);
  if (expectedSha256 !== undefined) {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expectedSha256.toLowerCase()) throw new Error("The animation checksum does not match.");
  }
  const { metadata, directory } = inspectAnimationV2(bytes);
  const canvas = Buffer.alloc(NBIF_FRAME_BYTES);
  for (let index = 0; index < directory.length; index += 1) {
    const entry = directory[index]!;
    if (entry.kind === AnimationFrameKind.Hold) {
      if (index === 0) fail("hold has no preceding frame");
      continue;
    }
    const { colors, offset } = unpackPalette(bytes, entry);
    decodeRows(bytes, entry, colors, offset, canvas);
  }
  return metadata;
}
