export const NBIF_V2_VERSION = 2;
export const NBIF_V2_HEADER_BYTES = 24;
export const NBIF_V2_DIRECTORY_ENTRY_BYTES = 20;
export const NBIF_V2_ROW_HEADER_BYTES = 6;
export const NBIF_V2_MAX_FILE_BYTES = 2_359_296;
export const NBIF_V2_MAX_FRAMES = 20;
export const NBIF_V2_MAX_DURATION_MS = 30_000;
export const NBIF_WIDTH = 240;
export const NBIF_HEIGHT = 240;
export const NBIF_FRAME_BYTES = NBIF_WIDTH * NBIF_HEIGHT * 2;

export enum AnimationFrameKind {
  Keyframe = 0,
  Delta = 1,
  Hold = 2,
}

export enum AnimationRowCodec {
  Rgb565Raw = 0,
  Rgb565Rle = 1,
  PackedIndices = 2,
  IndexedRle = 3,
}

export interface AnimationDirectoryEntry {
  recordOffset: number;
  recordBytes: number;
  delayMs: number;
  kind: AnimationFrameKind;
  indexBits: number;
  paletteCount: number;
  rowCount: number;
}

export interface AnimationV2Metadata {
  width: number;
  height: number;
  frameCount: number;
  durationMs: number;
  fileBytes: number;
  directory: AnimationDirectoryEntry[];
}
