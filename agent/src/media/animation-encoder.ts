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
} from "./animation-format.js";
import { decodeAnimationV2, validateAnimationV2 } from "./animation-decoder.js";

export interface AnimationFrameInput {
  pixels: Uint8Array;
  delayMs: number;
}

export interface EncodedAnimationV2 {
  bytes: Buffer;
  sha256: string;
  frameCount: number;
  durationMs: number;
}

interface PixelRow {
  y: number;
  x: number;
  values: number[];
}

interface EncodedRow {
  y: number;
  x: number;
  width: number;
  codec: AnimationRowCodec;
  payload: Buffer;
}

interface EncodedFrame {
  kind: AnimationFrameKind;
  delayMs: number;
  indexBits: number;
  palette: number[];
  rowCount: number;
  record: Buffer;
}

function framePixels(frame: AnimationFrameInput): Buffer {
  if (frame.pixels.byteLength !== NBIF_FRAME_BYTES) {
    throw new Error("NBIF v2 frames must contain exactly 240 by 240 RGB565 pixels.");
  }
  if (!Number.isInteger(frame.delayMs) || frame.delayMs < 20 || frame.delayMs > 0xffff) {
    throw new Error("NBIF v2 frame delays must be integers from 20 to 65535 ms.");
  }
  return Buffer.from(frame.pixels);
}

function collectRows(frame: Buffer, previous: Buffer | null, kind: AnimationFrameKind): PixelRow[] {
  const rows: PixelRow[] = [];
  for (let y = 0; y < NBIF_HEIGHT; y += 1) {
    let start = 0;
    let end = NBIF_WIDTH - 1;
    if (kind === AnimationFrameKind.Delta) {
      start = -1;
      end = -1;
      for (let x = 0; x < NBIF_WIDTH; x += 1) {
        const offset = (y * NBIF_WIDTH + x) * 2;
        if (frame.readUInt16LE(offset) !== previous!.readUInt16LE(offset)) {
          if (start < 0) start = x;
          end = x;
        }
      }
      if (start < 0) continue;
    }
    const values: number[] = [];
    for (let x = start; x <= end; x += 1) values.push(frame.readUInt16LE((y * NBIF_WIDTH + x) * 2));
    rows.push({ y, x: start, values });
  }
  return rows;
}

function indexBitCount(count: number): number {
  if (count <= 2) return 1;
  if (count <= 4) return 2;
  if (count <= 16) return 4;
  return 8;
}

function buildPalette(rows: readonly PixelRow[]): { colors: number[]; indexes: Map<number, number> } | null {
  const colors: number[] = [];
  const indexes = new Map<number, number>();
  for (const row of rows) {
    for (const color of row.values) {
      if (!indexes.has(color)) {
        if (colors.length === 256) return null;
        indexes.set(color, colors.length);
        colors.push(color);
      }
    }
  }
  return { colors, indexes };
}

function packValues(values: readonly number[], bytesPerValue: 1 | 2): Buffer {
  const packed = Buffer.alloc(values.length * bytesPerValue);
  values.forEach((value, index) => {
    if (bytesPerValue === 1) packed[index] = value;
    else packed.writeUInt16LE(value, index * 2);
  });
  return packed;
}

function encodeRle(values: readonly number[], bytesPerValue: 1 | 2): Buffer {
  const output: number[] = [];
  const append = (value: number) => {
    output.push(value & 0xff);
    if (bytesPerValue === 2) output.push((value >>> 8) & 0xff);
  };
  let offset = 0;
  while (offset < values.length) {
    let run = 1;
    while (offset + run < values.length && run < 128 && values[offset + run] === values[offset]) run += 1;
    if (run >= 3) {
      output.push(0x80 | (run - 1));
      append(values[offset] ?? 0);
      offset += run;
      continue;
    }
    const literalStart = offset;
    offset += run;
    while (offset < values.length && offset - literalStart < 128) {
      let nextRun = 1;
      while (offset + nextRun < values.length && nextRun < 3 && values[offset + nextRun] === values[offset]) nextRun += 1;
      if (nextRun >= 3) break;
      const capacity = 128 - (offset - literalStart);
      offset += Math.min(nextRun, capacity);
    }
    output.push(offset - literalStart - 1);
    for (let index = literalStart; index < offset; index += 1) append(values[index] ?? 0);
  }
  return Buffer.from(output);
}

function packIndexes(values: readonly number[], palette: ReadonlyMap<number, number>, bits: number): Buffer {
  const output = Buffer.alloc(Math.ceil(values.length * bits / 8));
  let bitOffset = 0;
  for (const color of values) {
    const index = palette.get(color);
    if (index === undefined) throw new Error("NBIF v2 palette does not contain an encoded pixel.");
    for (let bit = bits - 1; bit >= 0; bit -= 1) {
      if ((index & (1 << bit)) !== 0) {
        const byteOffset = bitOffset >> 3;
        output[byteOffset] = (output[byteOffset] ?? 0) | (1 << (7 - (bitOffset & 7)));
      }
      bitOffset += 1;
    }
  }
  return output;
}

function encodeRows(rows: readonly PixelRow[], palette: ReturnType<typeof buildPalette> | null): EncodedRow[] {
  const bits = palette ? indexBitCount(palette.colors.length) : 0;
  const encoded: EncodedRow[] = [];
  for (const row of rows) {
    const candidates: Array<{ codec: AnimationRowCodec; payload: Buffer; rank: number }> = [
      { codec: AnimationRowCodec.Rgb565Raw, payload: packValues(row.values, 2), rank: 0 },
      { codec: AnimationRowCodec.Rgb565Rle, payload: encodeRle(row.values, 2), rank: 1 },
    ];
    if (palette) {
      candidates.push(
        { codec: AnimationRowCodec.PackedIndices, payload: packIndexes(row.values, palette.indexes, bits), rank: 2 },
        { codec: AnimationRowCodec.IndexedRle, payload: encodeRle(row.values.map((color) => palette.indexes.get(color)!), 1), rank: 3 },
      );
    }
    candidates.sort((left, right) => left.payload.length - right.payload.length || left.rank - right.rank);
    const selected = candidates[0]!;
    if (selected.payload.length > 0xffff) throw new Error("NBIF v2 row payload exceeds the format limit.");
    encoded.push({ y: row.y, x: row.x, width: row.values.length, codec: selected.codec, payload: selected.payload });
  }
  return encoded;
}

function createRecord(rows: readonly EncodedRow[], palette: readonly number[]): Buffer {
  const paletteBytes = Buffer.alloc(palette.length * 2);
  palette.forEach((color, index) => paletteBytes.writeUInt16LE(color, index * 2));
  const rowRecords = rows.map((row) => {
    const header = Buffer.alloc(NBIF_V2_ROW_HEADER_BYTES);
    header[0] = row.y;
    header[1] = row.x;
    header[2] = row.width;
    header[3] = row.codec;
    header.writeUInt16LE(row.payload.length, 4);
    return Buffer.concat([header, row.payload]);
  });
  return Buffer.concat([paletteBytes, ...rowRecords]);
}

function createCandidate(
  pixels: Buffer,
  previous: Buffer | null,
  delayMs: number,
  kind: AnimationFrameKind,
): EncodedFrame {
  const rows = collectRows(pixels, previous, kind);
  const palette = buildPalette(rows);
  const rawRows = encodeRows(rows, null);
  const rawRecord = createRecord(rawRows, []);
  if (!palette) {
    return { kind, delayMs, indexBits: 0, palette: [], rowCount: rawRows.length, record: rawRecord };
  }
  const indexedRows = encodeRows(rows, palette);
  const indexedRecord = createRecord(indexedRows, palette.colors);
  if (indexedRecord.length < rawRecord.length) {
    return {
      kind, delayMs, indexBits: indexBitCount(palette.colors.length), palette: palette.colors,
      rowCount: indexedRows.length,
      record: indexedRecord,
    };
  }
  return { kind, delayMs, indexBits: 0, palette: [], rowCount: rawRows.length, record: rawRecord };
}

export class AnimationV2StreamEncoder {
  private readonly encoded: EncodedFrame[] = [];
  private previous: Buffer | null = null;
  private durationMs = 0;
  private recordBytes = 0;
  private finished = false;

  addFrame(input: AnimationFrameInput): void {
    if (this.finished) throw new Error("NBIF v2 encoder is already finished.");
    if (this.encoded.length >= NBIF_V2_MAX_FRAMES) throw new Error(`NBIF v2 requires 1 to ${NBIF_V2_MAX_FRAMES} frames.`);
    const pixels = framePixels(input);
    this.durationMs += input.delayMs;
    if (this.durationMs > NBIF_V2_MAX_DURATION_MS) throw new Error("NBIF v2 animation duration exceeds 30000 ms.");

    let selected = createCandidate(
      pixels,
      this.previous,
      input.delayMs,
      this.encoded.length === 0 ? AnimationFrameKind.Keyframe : AnimationFrameKind.Delta,
    );
    if (this.previous) {
      if (pixels.equals(this.previous)) {
        selected = { kind: AnimationFrameKind.Hold, delayMs: input.delayMs, indexBits: 0, palette: [], rowCount: 0, record: Buffer.alloc(0) };
      } else {
        const keyframe = createCandidate(pixels, null, input.delayMs, AnimationFrameKind.Keyframe);
        if (keyframe.record.length < selected.record.length) selected = keyframe;
      }
    }

    this.recordBytes += selected.record.length;
    const prospectiveSize = NBIF_V2_HEADER_BYTES + (this.encoded.length + 1) * NBIF_V2_DIRECTORY_ENTRY_BYTES + this.recordBytes;
    if (prospectiveSize > NBIF_V2_MAX_FILE_BYTES) throw new Error("NBIF v2 encoded animation exceeds the file size limit.");
    this.encoded.push(selected);
    this.previous = pixels;
  }

  finish(): EncodedAnimationV2 {
    if (this.finished) throw new Error("NBIF v2 encoder is already finished.");
    this.finished = true;
    if (this.encoded.length === 0) throw new Error(`NBIF v2 requires 1 to ${NBIF_V2_MAX_FRAMES} frames.`);
    const fileBytes = NBIF_V2_HEADER_BYTES + this.encoded.length * NBIF_V2_DIRECTORY_ENTRY_BYTES + this.recordBytes;
    const output = Buffer.alloc(fileBytes);
    output.write("NBIF", 0, "ascii");
    output[4] = 2;
    output[5] = 0;
    output.writeUInt16LE(NBIF_WIDTH, 6);
    output.writeUInt16LE(NBIF_HEIGHT, 8);
    output.writeUInt16LE(this.encoded.length, 10);
    output.writeUInt32LE(this.durationMs, 12);
    output.writeUInt32LE(fileBytes, 16);
    output.writeUInt32LE(0, 20);

    let recordOffset = NBIF_V2_HEADER_BYTES + this.encoded.length * NBIF_V2_DIRECTORY_ENTRY_BYTES;
    this.encoded.forEach((frame, index) => {
      const entryOffset = NBIF_V2_HEADER_BYTES + index * NBIF_V2_DIRECTORY_ENTRY_BYTES;
      output.writeUInt32LE(recordOffset, entryOffset);
      output.writeUInt32LE(frame.record.length, entryOffset + 4);
      output.writeUInt16LE(frame.delayMs, entryOffset + 8);
      output[entryOffset + 10] = frame.kind;
      output[entryOffset + 11] = frame.indexBits;
      output.writeUInt16LE(frame.palette.length, entryOffset + 12);
      output.writeUInt16LE(frame.rowCount, entryOffset + 14);
      output.writeUInt32LE(0, entryOffset + 16);
      frame.record.copy(output, recordOffset);
      recordOffset += frame.record.length;
    });

    const sha256 = createHash("sha256").update(output).digest("hex");
    validateAnimationV2(output, sha256);
    this.encoded.length = 0;
    this.previous = null;
    return { bytes: output, sha256, frameCount: Number(output.readUInt16LE(10)), durationMs: this.durationMs };
  }

}

export function encodeAnimationV2(frames: readonly AnimationFrameInput[]): EncodedAnimationV2 {
  if (frames.length < 1 || frames.length > NBIF_V2_MAX_FRAMES) {
    throw new Error(`NBIF v2 requires 1 to ${NBIF_V2_MAX_FRAMES} frames.`);
  }
  const encoder = new AnimationV2StreamEncoder();
  for (const frame of frames) encoder.addFrame(frame);
  return encoder.finish();
}

export { decodeAnimationV2, validateAnimationV2 };
