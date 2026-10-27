// Offline fixtures only. This script has no device client or upload operation.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { createCoverAsset, validateAnimation, validateCover } from "../src/media/animation.js";

const output = resolve(process.argv[2] ?? "../build/display-color-fixtures");
const colors = [
  { name: "red", rgb: [255, 0, 0], word: 0xf800 },
  { name: "green", rgb: [0, 255, 0], word: 0x07e0 },
  { name: "blue", rgb: [0, 0, 255], word: 0x001f },
  { name: "white", rgb: [255, 255, 255], word: 0xffff },
  { name: "black", rgb: [0, 0, 0], word: 0x0000 },
  { name: "cyan", rgb: [0, 255, 255], word: 0x07ff },
  { name: "magenta", rgb: [255, 0, 255], word: 0xf81f },
  { name: "yellow", rgb: [255, 255, 0], word: 0xffe0 },
];
const rgba = Buffer.alloc(240 * 240 * 4);
for (let y = 0; y < 240; y++) for (let x = 0; x < 240; x++) {
  const color = colors[Math.floor(x / 30)]!;
  rgba.set([...color.rgb, 255], (y * 240 + x) * 4);
}
const cover = createCoverAsset(rgba, 240, 240);
validateCover(cover.bytes, cover.sha256);
const animation = Buffer.alloc(11 + 2 + 240 * 240 * 2);
animation.write("NBIF"); animation[4] = 1;
animation.writeUInt16LE(240, 5); animation.writeUInt16LE(240, 7);
animation.writeUInt16LE(1, 9); animation.writeUInt16LE(1000, 11);
cover.bytes.copy(animation, 13, 9);
const animationHash = createHash("sha256").update(animation).digest("hex");
validateAnimation(animation, animationHash);
await mkdir(output, { recursive: true });
await writeFile(resolve(output, "primary-colors.nbic"), cover.bytes);
await writeFile(resolve(output, "primary-colors.nbif"), animation);
await sharp(rgba, { raw: { width: 240, height: 240, channels: 4 } }).png().toFile(resolve(output, "primary-colors.png"));
await writeFile(resolve(output, "manifest.json"), JSON.stringify({
  scope: "Offline fixtures; device use requires separate authorization",
  width: 240, height: 240, stripeWidth: 30,
  colors: colors.map(({ name, word }) => ({ name, rgb565: word.toString(16).padStart(4, "0"),
    assetBytes: [word & 255, word >> 8], spiBytes: [word >> 8, word & 255] })),
  cover: { bytes: cover.bytes.length, sha256: cover.sha256 },
  animation: { bytes: animation.length, sha256: animationHash },
}, null, 2) + "\n");
console.log(`Prepared offline display-color fixtures in ${output}. No device accessed.`);
