import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FirmwareInbox, type FirmwareManifest } from "../src/device/firmware-inbox.js";
import type { RecoveryCredential } from "../src/device/recovery-store.js";
import { restrictWindowsAcl } from "./windows-acl.js";

const binding: Pick<RecoveryCredential, "deviceId" | "profile" | "recoveryIdentityFingerprint"> = {
  deviceId: "esp8266-a1b2c3", profile: "esp8266-dio40-4mb", recoveryIdentityFingerprint: "a".repeat(64),
};

function imageBytes(): Buffer {
  const bytes = Buffer.alloc(0x1030, 0);
  for (const offset of [0, 0x1000]) {
    bytes[offset] = 0xe9; bytes[offset + 1] = 1; bytes[offset + 2] = 2; bytes[offset + 3] = 0x40;
  }
  return bytes;
}

function manifest(bytes: Buffer, overrides: Partial<FirmwareManifest> = {}): FirmwareManifest {
  return {
    schemaVersion: 1, fileName: "firmware.bin", byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), imageFormat: "esp8266-combined-e9",
    firmwareVersion: "0.2.0-stage3", buildId: "build-20261027-a1b2", deviceId: binding.deviceId,
    profile: binding.profile, recoveryIdentityFingerprint: binding.recoveryIdentityFingerprint,
    sourceRevision: "1".repeat(40), target: { family: "esp8266", flashMode: "dio", flashFrequencyMHz: 40, flashBytes: 4_194_304 },
    linkedRegions: { bootloaderStart: 0, applicationStart: 4096, filesystemStart: 1_048_576,
      filesystemEnd: 4_177_920, eepromStart: 4_177_920 },
    featureGates: { maintenanceOnBoot: true, otaEnabled: true },
    minimumResources: { minimumFreeHeapBytes: 20_000, minimumLargestBlockBytes: 8_192 },
    validation: { combinedImage: true, modernCrc: true, runtimeBounds: true, recoveryIdentity: true },
    ...overrides,
  };
}

async function makeInbox(t: TestContext, overrides: Record<string, unknown> = {}, bytes = imageBytes()) {
  const directory = await mkdtemp(join(tmpdir(), "neonbyte-inbox-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "firmware.bin"), bytes);
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest(bytes, overrides)));
  return { directory, bytes };
}

test("protected inbox returns a bounded opaque candidate from an immutable verified snapshot", async (t) => {
  const { directory, bytes } = await makeInbox(t);
  let protectedDirectory = "";
  const inbox = new FirmwareInbox({ directory, accessControl: { protectAndVerify: async (value) => { protectedDirectory = value; } } });
  const candidate = await inbox.prepare(binding);
  assert.equal(protectedDirectory, directory);
  assert.match(candidate.id, /^[0-9a-f-]{36}$/);
  assert.equal(candidate.fileName, "firmware.bin");
  assert.equal(candidate.byteLength, bytes.length);
  assert.equal(candidate.manifest.buildId, "build-20261027-a1b2");
  assert.deepEqual(candidate.bytes, bytes);

  await writeFile(join(directory, "firmware.bin"), Buffer.alloc(bytes.length, 0xff));
  assert.deepEqual(candidate.bytes, bytes);
});

test("inbox rejects missing, extra, incomplete, mutated, and oversized local files", async (t) => {
  const missingDir = await mkdtemp(join(tmpdir(), "neonbyte-inbox-missing-"));
  t.after(() => rm(missingDir, { recursive: true, force: true }));
  await assert.rejects(new FirmwareInbox({ directory: missingDir, accessControl: { protectAndVerify: async () => {} } }).prepare(binding), /firmware pair is incomplete/);

  const { directory } = await makeInbox(t);
  await writeFile(join(directory, "unexpected.bin"), "unexpected");
  await assert.rejects(new FirmwareInbox({ directory, accessControl: { protectAndVerify: async () => {} } }).prepare(binding), /only firmware.bin and manifest.json/);

  const changing = await mkdtemp(join(tmpdir(), "neonbyte-inbox-change-"));
  t.after(() => rm(changing, { recursive: true, force: true }));
  const bytes = imageBytes();
  await writeFile(join(changing, "firmware.bin"), bytes);
  await writeFile(join(changing, "manifest.json"), JSON.stringify(manifest(bytes)));
  await writeFile(join(changing, "firmware.bin"), Buffer.alloc(bytes.length, 0xee));
  await assert.rejects(new FirmwareInbox({ directory: changing, accessControl: { protectAndVerify: async () => {} } }).prepare(binding), /SHA-256/);

  const oversized = Buffer.alloc(458_753);
  await assert.rejects((async () => {
    const path = await mkdtemp(join(tmpdir(), "neonbyte-inbox-large-"));
    t.after(() => rm(path, { recursive: true, force: true }));
    await writeFile(join(path, "firmware.bin"), oversized);
    await writeFile(join(path, "manifest.json"), JSON.stringify(manifest(oversized)));
    await new FirmwareInbox({ directory: path, accessControl: { protectAndVerify: async () => {} } }).prepare(binding);
  })(), /exceeds its local size limit/);
});

test("inbox binds manifest identity and rejects public, wrong-profile, or unsupported image candidates", async (t) => {
  for (const [overrides, fileBytes, message] of [
    [{ deviceId: "esp8266-other" }, imageBytes(), /device identity/],
    [{ profile: "public-compile-only" }, imageBytes(), /profile/],
    [{ featureGates: { maintenanceOnBoot: true, otaEnabled: false } }, imageBytes(), /feature gates/],
    [{ recoveryIdentityFingerprint: "b".repeat(64) }, imageBytes(), /recovery identity/],
    [{}, Buffer.alloc(0x1030, 0xff), /combined DIO 40 MHz/],
  ] as const) {
    const { directory } = await makeInbox(t, overrides, fileBytes);
    await assert.rejects(new FirmwareInbox({ directory, accessControl: { protectAndVerify: async () => {} } }).prepare(binding), message);
  }
});

test("local inbox permissions are restricted and candidate preparation never watches files", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "neonbyte-inbox-parent-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, "firmware-inbox");
  await mkdir(directory, { mode: 0o700 });
  const bytes = imageBytes();
  await writeFile(join(directory, "firmware.bin"), bytes, { mode: 0o600 });
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest(bytes)), { mode: 0o600 });
  for (const path of [directory, join(directory, "firmware.bin"), join(directory, "manifest.json")]) restrictWindowsAcl(path);
  const candidate = await new FirmwareInbox({ directory }).prepare(binding);
  assert.equal(candidate.fileName, "firmware.bin");
  assert.deepEqual((await readdir(directory)).sort(), ["firmware.bin", "manifest.json"]);
});
