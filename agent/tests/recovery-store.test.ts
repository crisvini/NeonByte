import assert from "node:assert/strict";
import test from "node:test";
import { computeRecoveryIdentityFingerprint, enrollRecoveryCredential, type RecoveryCredential,
  type RecoveryCredentialStore } from "../src/device/recovery-store.js";

const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const apPassword = "fedcba9876543210fedcba9876543210";
const fingerprint = "1a1e8dfe18e8e6874d73d60bc9637606761918c5a6672b02a088f60a6fac550a";
const expected: RecoveryCredential = { version: 1, token, deviceId: "esp8266-a1b2c3", recoveryIdentityFingerprint: fingerprint,
  lastVerifiedAddress: "http://192.168.1.20", profile: "esp8266-dio40-4mb" };

class MemoryRecoveryStore implements RecoveryCredentialStore {
  value: RecoveryCredential | null = null;
  failReadback = false;
  writes = 0;
  async get() { return this.failReadback && this.writes > 0 ? null : this.value; }
  async set(value: RecoveryCredential) { this.writes++; this.value = { ...value }; }
  async delete() { this.value = null; }
}

const maintenanceInfo = { deviceId: expected.deviceId, bootId: "0123456789abcdef0123456789abcdef", buildId: "build-20261027-a1b2",
  firmwareVersion: "0.1.0-phase4", stationIp: "192.168.1.20", recoveryApIp: "192.168.4.1", otaEnabled: true,
  maxFirmwareBytes: 458752, profile: expected.profile, recoveryIdentityFingerprint: fingerprint };

test("recovery fingerprint uses the fixed domain, NUL separators, and exact identity bytes", () => {
  assert.equal(computeRecoveryIdentityFingerprint(token, apPassword), fingerprint);
});

test("enrollment requires matching authenticated device identity before adding a separate record", async () => {
  const store = new MemoryRecoveryStore();
  const saved = await enrollRecoveryCredential({ store, client: { info: async () => maintenanceInfo }, token, apPassword,
    address: "http://192.168.1.20", expectedDeviceId: expected.deviceId, expectedProfile: expected.profile,
    expectedFingerprint: fingerprint });
  assert.deepEqual(saved, expected);
  assert.deepEqual(store.value, expected);
  assert.equal(store.writes, 1);
});

test("enrollment does not trust a candidate-supplied fingerprint or overwrite a prior record", async () => {
  const mismatchedStore = new MemoryRecoveryStore();
  await assert.rejects(enrollRecoveryCredential({ store: mismatchedStore, client: { info: async () => ({ ...maintenanceInfo, recoveryIdentityFingerprint: "b".repeat(64) }) },
    token, apPassword, address: expected.lastVerifiedAddress, expectedDeviceId: expected.deviceId,
    expectedProfile: expected.profile, expectedFingerprint: fingerprint }), /identity could not be verified/);
  assert.equal(mismatchedStore.writes, 0);

  const existingStore = new MemoryRecoveryStore(); existingStore.value = expected;
  await assert.rejects(enrollRecoveryCredential({ store: existingStore, client: { info: async () => maintenanceInfo },
    token: "f".repeat(64), apPassword, address: expected.lastVerifiedAddress, expectedDeviceId: expected.deviceId,
    expectedProfile: expected.profile, expectedFingerprint: "c".repeat(64) }), /already enrolled/);
  assert.deepEqual(existingStore.value, expected);
  assert.equal(existingStore.writes, 0);
});

test("an unreadable enrollment readback removes the unverified new record without changing legacy stores", async () => {
  const store = new MemoryRecoveryStore(); store.failReadback = true;
  await assert.rejects(enrollRecoveryCredential({ store, client: { info: async () => maintenanceInfo }, token, apPassword,
    address: expected.lastVerifiedAddress, expectedDeviceId: expected.deviceId, expectedProfile: expected.profile,
    expectedFingerprint: fingerprint }), /could not be verified in the credential manager/);
  assert.equal(store.value, null);
});
