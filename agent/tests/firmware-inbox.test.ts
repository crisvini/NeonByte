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
  const bytes = Buffer.alloc(0x1060, 0);
  const write32 = (offset: number, value: number) => bytes.writeUInt32LE(value >>> 0, offset);
  bytes.set([0xe9, 1, 2, 0x40], 0);
  write32(4, 0x40100000);
  write32(8, 0x40100000);
  write32(12, 16);
  for (let index = 0; index < 16; index++) bytes[16 + index] = index + 1;
  let bootChecksum = 0xef;
  for (let index = 16; index < 32; index++) bootChecksum ^= bytes[index]!;
  bytes[47] = bootChecksum;

  bytes.set([0xe9, 1, 2, 0x40], 0x1000);
  write32(0x1004, 0x40100000);
  write32(0x1008, 0x40201010);
  write32(0x100c, 0x40);
  write32(0x1010, bytes.length);
  bytes[0x105f] = 0xef;
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    crc ^= (index >= 0x1010 && index < 0x1018 ? 0 : bytes[index]!) << 24;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0)) >>> 0;
  }
  write32(0x1014, crc);
  return bytes;
}

function recomputeModernCrc(bytes: Buffer): Buffer {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    crc ^= (index >= 0x1010 && index < 0x1018 ? 0 : bytes[index]!) << 24;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0)) >>> 0;
  }
  bytes.writeUInt32LE(crc, 0x1014);
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
      filesystemEnd: 4_169_728, eepromStart: 4_173_824 },
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
    [{}, Buffer.alloc(0x1030, 0xff), /image/],
  ] as const) {
    const { directory } = await makeInbox(t, overrides, fileBytes);
    await assert.rejects(new FirmwareInbox({ directory, accessControl: { protectAndVerify: async () => {} } }).prepare(binding), message);
  }
});

test("experimental inbox candidates retain image and identity checks while leaving resource floors pending", async (t) => {
  const bytes = imageBytes();
  const { directory } = await makeInbox(t, {
    purpose: "experimental-test",
    minimumResources: null,
  }, bytes);
  const candidate = await new FirmwareInbox({ directory, accessControl: { protectAndVerify: async () => {} } }).prepare(binding);
  assert.equal(candidate.manifest.purpose, "experimental-test");
  assert.equal(candidate.manifest.minimumResources, null);
  assert.equal(candidate.manifest.sourceRevision, "1".repeat(40));
  assert.equal(candidate.manifest.linkedRegions.filesystemStart, 1_048_576);
  assert.equal(candidate.manifest.linkedRegions.filesystemEnd, 4_169_728);
  assert.equal(candidate.manifest.linkedRegions.eepromStart, 4_173_824);

  const production = await makeInbox(t, { minimumResources: null }, bytes);
  await assert.rejects(new FirmwareInbox({ directory: production.directory, accessControl: { protectAndVerify: async () => {} } }).prepare(binding), /manifest/);
});

test("only experimental manifests may defer runtime geometry while retaining resource floors", async (t) => {
  const pending = { state: "device-check-pending", requiredBuildId: "build-old" };
  const validation = { combinedImage: true, modernCrc: true, runtimeBounds: pending, recoveryIdentity: true };
  const resources = { minimumFreeHeapBytes: 22_168, minimumLargestBlockBytes: 21_544 };
  const experimental = await makeInbox(t, { purpose: "experimental-test", minimumResources: resources, validation });
  const inbox = new FirmwareInbox({ directory: experimental.directory, accessControl: { protectAndVerify: async () => {} } });
  const candidate = await inbox.prepare(binding);
  assert.deepEqual(candidate.manifest.validation.runtimeBounds, pending);
  assert.deepEqual(candidate.manifest.minimumResources, resources);

  const production = await makeInbox(t, { minimumResources: resources, validation });
  await assert.rejects(new FirmwareInbox({ directory: production.directory, accessControl: { protectAndVerify: async () => {} } }).prepare(binding), /manifest/);
  for (const value of [false, null, "pending", "device-check-pending", { state: "device-check-pending" },
    { state: "device-check-pending", requiredBuildId: "" }, { state: "device-check-pending", requiredBuildId: "build-old", extra: true }]) {
    const invalid = await makeInbox(t, { purpose: "experimental-test", minimumResources: resources,
      validation: { ...validation, runtimeBounds: value } });
    await assert.rejects(new FirmwareInbox({ directory: invalid.directory, accessControl: { protectAndVerify: async () => {} } }).prepare(binding), /manifest/);
  }
});

test("deferred experimental geometry does not relax identity or image integrity checks", async (t) => {
  const pending = { purpose: "experimental-test", minimumResources: null,
    validation: { combinedImage: true, modernCrc: true, runtimeBounds: { state: "device-check-pending", requiredBuildId: "build-old" }, recoveryIdentity: true } };
  const wrongIdentity = await makeInbox(t, { ...pending, deviceId: "esp8266-other" });
  await assert.rejects(new FirmwareInbox({ directory: wrongIdentity.directory, accessControl: { protectAndVerify: async () => {} } }).prepare(binding), /device identity/);
  const badImage = await makeInbox(t, pending, Buffer.alloc(0x1030, 0xff));
  await assert.rejects(new FirmwareInbox({ directory: badImage.directory, accessControl: { protectAndVerify: async () => {} } }).prepare(binding), /image/);
});

test("inbox validates complete image checksums and the exact linked 4m3m layout", async (t) => {
  for (const [name, mutate, overrides] of [
    ["boot segment checksum", (bytes: Buffer) => { bytes[16] = bytes[16]! ^ 1; return bytes; }, {}],
    ["application segment checksum with valid modern CRC", (bytes: Buffer) => {
      bytes[0x1018] = bytes[0x1018]! ^ 1;
      return recomputeModernCrc(bytes);
    }, {}],
    ["modern CRC", (bytes: Buffer) => { bytes[0x1014] = bytes[0x1014]! ^ 1; return bytes; }, {}],
    ["trailing byte", (bytes: Buffer) => Buffer.concat([bytes, Buffer.from([0])]), {}],
    ["linked layout", (bytes: Buffer) => bytes, { linkedRegions: { bootloaderStart: 0, applicationStart: 4096,
      filesystemStart: 2_097_152, filesystemEnd: 4_169_728, eepromStart: 4_173_824 } }],
  ] as const) {
    const bytes = mutate(imageBytes());
    const { directory } = await makeInbox(t, overrides, bytes);
    await assert.rejects(new FirmwareInbox({ directory, accessControl: { protectAndVerify: async () => {} } }).prepare(binding), /image|CRC|layout|manifest/i, name);
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

test("automatic-start candidates require explicit maintenance after software restart while legacy manifests remain valid", async (t) => {
  for (const gates of [
    { maintenanceOnBoot: true, otaEnabled: true },
    { maintenanceOnBoot: false, otaEnabled: true, maintenanceAfterSoftwareRestart: true },
  ]) {
    const { directory } = await makeInbox(t, { featureGates: gates });
    const value = await new FirmwareInbox({ directory, accessControl: { protectAndVerify: async () => {} } }).prepare(binding);
    assert.equal(value.manifest.featureGates.maintenanceOnBoot, gates.maintenanceOnBoot);
  }
  for (const gates of [
    { maintenanceOnBoot: false, otaEnabled: true },
    { maintenanceOnBoot: false, otaEnabled: true, maintenanceAfterSoftwareRestart: false },
    { maintenanceOnBoot: false, otaEnabled: true, maintenanceAfterSoftwareRestart: "true" },
    { maintenanceOnBoot: false, otaEnabled: true, maintenanceAfterSoftwareRestart: true, unknown: true },
  ]) {
    const { directory } = await makeInbox(t, { featureGates: gates });
    await assert.rejects(new FirmwareInbox({ directory, accessControl: { protectAndVerify: async () => {} } }).prepare(binding), /manifest|feature gates/);
  }
});
