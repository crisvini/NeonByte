import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, "../..");
const source = resolve(projectDirectory, "assets/branding/neonbyte-retro-original.png");
const output = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(scriptDirectory, "../src/web/public");

await mkdir(output, { recursive: true });
await sharp(source, { limitInputPixels: 4_000_000 })
  .rotate()
  .resize(256, 256, { fit: "contain", background: "#100914" })
  .webp({ quality: 88, effort: 4 })
  .toFile(join(output, "neonbyte-logo.webp"));

for (const size of [32, 48]) {
  await sharp(source, { limitInputPixels: 4_000_000 })
    .rotate()
    .resize(size, size, { fit: "contain", background: "#100914" })
    .png()
    .toFile(join(output, `favicon-${size}.png`));
}
