import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { DeviceClient } from "../../src/device/client.js";
import { convertGifToAnimation } from "../../src/media/animation.js";
import { startHarness } from "./harness.js";

const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const twoFrameGif = Buffer.concat([
  gif.subarray(0, -1), Buffer.from([0x21, 0xf9, 4, 0, 7, 0, 0, 0]),
  Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]), Buffer.from([2, 1, 0x44, 0, 0x3b]),
]);
twoFrameGif[23] = 5;
// Make the second frame a different color using disposal to an opaque red background.
twoFrameGif[11] = 1; twoFrameGif[16] = 255; twoFrameGif[17] = 0; twoFrameGif[18] = 0;
twoFrameGif[22] = 8; twoFrameGif[44] = 1; twoFrameGif[47] = 0;
const animation = convertGifToAnimation(twoFrameGif);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("converted GIF pixels and delays survive PC disconnection, repeated reads, and actual device-process restarts", async (t) => {
  const harness = await startHarness(t);
  const client = new DeviceClient({ baseUrl: harness.url, token: harness.token });
  await client.uploadAnimation(animation); await client.setMode("gif");
  assert.equal((await harness.state()).animationSha, animation.sha256);
  const redPixels = Buffer.alloc(115_200);
  for (let index = 0; index < redPixels.length; index += 2) redPixels.writeUInt16LE(0xf800, index);
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const first = await harness.frame(0), second = await harness.frame(1);
    assert.deepEqual(first, { ok: true, bytes: 115_200, delayMs: 50, sha256: sha(Buffer.alloc(115_200)) });
    assert.deepEqual(second, { ok: true, bytes: 115_200, delayMs: 70, sha256: sha(redPixels) });
    await harness.advance(60_000);
  }
  assert.equal((await harness.state()).agentAvailable, false);
  await harness.restart();
  assert.equal((await client.status()).mode, "gif");
  assert.equal((await harness.state()).animationFrames, 2);
  assert.equal((await harness.frame(1)).sha256, sha(redPixels));
  await client.setMode("spotify"); await harness.restart();
  assert.equal((await client.status()).mode, "spotify");
  assert.equal((await harness.state()).waiting, true);
});

test("failed, corrupt, incomplete, and low-space replacement preserve the installed GIF across restart", async (t) => {
  const harness = await startHarness(t);
  const client = new DeviceClient({ baseUrl: harness.url, token: harness.token });
  await client.uploadAnimation(animation);
  const replacement = convertGifToAnimation(gif);
  const upload = (bytes: Buffer, hash: string) => fetch(`${harness.url}/api/v1/animation`, {
    method: "PUT", headers: { Authorization: `Bearer ${harness.token}`, "Content-Type": "application/octet-stream", "X-Content-SHA256": hash }, body: bytes,
  });
  assert.equal((await upload(replacement.bytes, "0".repeat(64))).status, 422);
  const corrupt = Buffer.from(replacement.bytes); corrupt.writeUInt16LE(0, 11);
  assert.equal((await upload(corrupt, sha(corrupt))).status, 422);
  for (const fault of ["write", "promote", "read"]) {
    await harness.fault(fault, false);
    await assert.rejects(client.uploadAnimation(replacement));
    await harness.fault(fault, true);
    assert.equal((await harness.state()).animationSha, animation.sha256);
  }
  await harness.fault("capacity", animation.bytes.length + 32768);
  await assert.rejects(client.uploadAnimation(replacement));
  await harness.fault("capacity", 4 * 1024 * 1024);
  const header = `PUT /api/v1/animation HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${harness.token}\r\nContent-Type: application/octet-stream\r\nContent-Length: ${replacement.bytes.length}\r\nX-Content-SHA256: ${replacement.sha256}\r\n\r\n`;
  assert.equal((await harness.raw(header, replacement.bytes.subarray(0, 4096))).status, 422);
  assert.equal((await harness.state()).animationSha, animation.sha256);
  await harness.raw(header, replacement.bytes.subarray(0, 4096), true);
  assert.ok((await readdir(harness.directory)).includes("animation.part"));
  await harness.restart(true, true);
  assert.ok(!(await readdir(harness.directory)).includes("animation.part"));
  assert.equal(sha(await readFile(join(harness.directory, "animation.nbif"))), animation.sha256);
  await client.uploadAnimation(replacement);
  assert.equal((await harness.state()).animationSha, replacement.sha256);
});

test("mode persistence failures preserve both current state and previously installed settings", async (t) => {
  const harness = await startHarness(t);
  const client = new DeviceClient({ baseUrl: harness.url, token: harness.token });
  await client.setMode("gif");
  await harness.fault("promote", false);
  await assert.rejects(client.setMode("spotify"));
  assert.equal((await client.status()).mode, "gif");
  await harness.restart();
  assert.equal((await client.status()).mode, "gif");
});
