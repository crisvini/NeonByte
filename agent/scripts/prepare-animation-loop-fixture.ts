import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseGIF } from "gifuct-js";
import { convertGifToAnimationV2 } from "../src/media/animation.js";
import { decodeAnimationV2 } from "../src/media/animation-decoder.js";

const input = process.argv[2];
if (!input) throw new Error("Usage: prepare-animation-loop-fixture.ts <source.gif> [output-directory]");
const output = resolve(process.argv[3] ?? "../build/gif-loop");
const source = await readFile(input);
const gif = parseGIF(source);
const asset = convertGifToAnimationV2(source);
const decoded = decodeAnimationV2(asset.bytes);
const frames = decoded.frames.map((frame, index) => {
  const directory = 24 + index * 20;
  return {
    index, delayMs: decoded.delaysMs[index], sha256: createHash("sha256").update(frame).digest("hex"),
    recordBytes: asset.bytes.readUInt32LE(directory + 4), kind: asset.bytes[directory + 10],
    paletteCount: asset.bytes.readUInt16LE(directory + 12), rowCount: asset.bytes.readUInt16LE(directory + 14),
  };
});
const manifest = {
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  sourceDelaysCentiseconds: gif.frames.filter((frame) => frame.image).map((frame) => frame.gce?.delay ?? null),
  frameCount: asset.frameCount, durationMs: asset.durationMs, nbifBytes: asset.bytes.length,
  nbifSha256: asset.sha256, frames,
};
await mkdir(output, { recursive: true });
await writeFile(resolve(output, "animation.nbif"), asset.bytes);
await writeFile(resolve(output, "animation.rgb565"), Buffer.concat(decoded.frames));
await writeFile(resolve(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ frameCount: asset.frameCount, delaysMs: decoded.delaysMs, output }));
