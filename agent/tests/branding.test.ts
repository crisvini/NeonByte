import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import test from "node:test";

test("official logo derivatives preserve the source artwork and generate square browser assets", async (t) => {
  const agentDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const outputDirectory = await mkdtemp(join(tmpdir(), "neonbyte-branding-"));
  t.after(async () => rm(outputDirectory, { recursive: true, force: true }));

  const sourcePath = resolve(agentDirectory, "../assets/branding/neonbyte-retro-original.png");
  const source = await readFile(sourcePath);
  const metadata = await sharp(source).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 1254);
  assert.equal(metadata.height, 1254);

  const result = spawnSync(process.execPath, [join(agentDirectory, "scripts/prepare-brand-assets.mjs"), outputDirectory], {
    cwd: agentDirectory,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  const logo = await sharp(await readFile(join(outputDirectory, "neonbyte-logo.webp"))).metadata();
  assert.equal(logo.format, "webp");
  assert.equal(logo.width, 256);
  assert.equal(logo.height, 256);
  for (const size of [32, 48]) {
    const favicon = await sharp(await readFile(join(outputDirectory, `favicon-${size}.png`))).metadata();
    assert.equal(favicon.format, "png");
    assert.equal(favicon.width, size);
    assert.equal(favicon.height, size);
  }
});
