import assert from "node:assert/strict";
import test from "node:test";
import { runRecoveryEnrollment, type EnrollmentPrompts } from "../src/device/recovery-enrollment.js";
import { computeRecoveryIdentityFingerprint, type RecoveryCredential, type RecoveryCredentialStore } from "../src/device/recovery-store.js";
import type { DeviceConfig, DeviceConfigStore } from "../src/device/integration.js";

const legacyToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const recoveryToken = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const apPassword = "fedcba9876543210fedcba9876543210";
const deviceId = "esp8266-a1b2c3";
const profile = "esp8266-dio40-4mb";

class MemoryRecoveryStore implements RecoveryCredentialStore {
  value: RecoveryCredential | null = null;
  writes = 0;
  async get() { return this.value; }
  async set(value: RecoveryCredential) { this.writes++; this.value = { ...value }; }
  async delete() { this.value = null; }
}

test("foreground enrollment can opt in to the saved pairing token without rewriting legacy or Spotify stores", async () => {
  const recoveryStore = new MemoryRecoveryStore();
  let pairingWrites = 0;
  const deviceStore: DeviceConfigStore = {
    get: async () => ({ address: "http://192.168.1.20", token: legacyToken, enabled: true }),
    set: async () => { pairingWrites++; },
  };
  const prompts: EnrollmentPrompts = {
    address: async () => "http://192.168.1.20",
    expectedDeviceId: async () => deviceId,
    expectedProfile: async () => profile,
    expectedFingerprint: async () => computeRecoveryIdentityFingerprint(legacyToken, apPassword),
    reusePairingToken: async () => true,
    recoveryToken: async () => { throw new Error("The saved token should be reused only after explicit consent."); },
    apPassword: async () => apPassword,
  };
  const info = { deviceId, bootId: "boot-01", buildId: "build-01", firmwareVersion: "0.1.0", stationIp: "192.168.1.20",
    recoveryApIp: "192.168.4.1", otaEnabled: true, maxFirmwareBytes: 458752, profile,
    recoveryIdentityFingerprint: computeRecoveryIdentityFingerprint(legacyToken, apPassword) };

  const result = await runRecoveryEnrollment({ prompts, deviceStore, recoveryStore,
    createClient: (address, token) => {
      assert.equal(address, "http://192.168.1.20");
      assert.equal(token, legacyToken);
      return { info: async () => info };
    } });
  assert.equal(result.deviceId, deviceId);
  assert.equal(recoveryStore.value?.token, legacyToken);
  assert.equal(recoveryStore.writes, 1);
  assert.equal(pairingWrites, 0);
});

test("foreground enrollment accepts a separate recovery token and does not expose it in the result", async () => {
  const recoveryStore = new MemoryRecoveryStore();
  const legacy: DeviceConfig = { address: "http://192.168.1.20", token: legacyToken, enabled: true };
  const deviceStore: DeviceConfigStore = { get: async () => legacy, set: async () => assert.fail("Legacy pairing must remain untouched.") };
  const fingerprint = computeRecoveryIdentityFingerprint(recoveryToken, apPassword);
  const prompts: EnrollmentPrompts = {
    address: async () => legacy.address,
    expectedDeviceId: async () => deviceId,
    expectedProfile: async () => profile,
    expectedFingerprint: async () => fingerprint,
    reusePairingToken: async () => false,
    recoveryToken: async () => recoveryToken,
    apPassword: async () => apPassword,
  };
  const result = await runRecoveryEnrollment({ prompts, deviceStore, recoveryStore,
    createClient: (_address, value) => {
      assert.equal(value, recoveryToken);
      return { info: async () => ({ deviceId, bootId: "boot-01", buildId: "build-01", firmwareVersion: "0.1.0",
        stationIp: "192.168.1.20", recoveryApIp: "192.168.4.1", otaEnabled: true, maxFirmwareBytes: 458752,
        profile, recoveryIdentityFingerprint: fingerprint }) };
    } });
  assert.equal(Object.hasOwn(result, "token"), false);
  assert.equal(recoveryStore.value?.token, recoveryToken);
  assert.deepEqual(legacy, { address: "http://192.168.1.20", token: legacyToken, enabled: true });
});
