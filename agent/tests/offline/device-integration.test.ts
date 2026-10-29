import assert from "node:assert/strict";
import test from "node:test";
import { DeviceIntegration, type DeviceConfig, type DeviceConfigStore } from "../../src/device/integration.js";
import { createTestModeController } from "../helpers/mode-state.js";
import { PlaybackPoller } from "../../src/spotify/poller.js";
import { MockSpotifyProvider } from "../../src/spotify/mock.js";
import { startLocalWebApp } from "../../src/web/server.js";
import type { RecoveryCredential, RecoveryCredentialStore } from "../../src/device/recovery-store.js";
import { EPOCH, startHarness } from "./harness.js";

class MemoryStore implements DeviceConfigStore {
  value: DeviceConfig | null = null;
  async get() { return this.value; }
  async set(value: DeviceConfig) { this.value = { ...value }; }
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Device state did not change.");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("dashboard configuration drives the native firmware through restart, outage, address change, and shutdown", async (t) => {
  const first = await startHarness(t);
  const second = await startHarness(t);
  const store = new MemoryStore();
  const poller = new PlaybackPoller({ provider: new MockSpotifyProvider({ is_playing: true, progress_ms: 1000,
    item: { type: "track", id: "lifecycle-track", name: "Lifecycle Track", duration_ms: 180000,
      artists: [{ name: "Test Artist" }], album: { images: [] } } }), pollIntervalMs: 15000, now: () => EPOCH });
  await poller.pollOnce();
  const modeController = await createTestModeController();
  let device = new DeviceIntegration({ modeController, store, poller, intervalMs: 30 });
  await device.start();
  const app = await startLocalWebApp({ poller, modeController, device, oauth: null, spotifyConfigured: false, port: 0 });
  t.after(async () => { await app.close(); await device.stop(); });
  const origin = `http://127.0.0.1:${app.port}`;
  const post = (data: unknown) => fetch(`${origin}/api/device`, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const before = first.requests.length;
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.equal(first.requests.length, before);
  assert.equal((await post({ address: first.url, token: first.token, enabled: true })).status, 400);
  await device.configure({ address: first.url, token: first.token, enabled: true });
  assert.equal((await post({ address: first.url, enabled: true })).status, 204);
  await waitFor(() => device.status.connection === "connected");
  assert.equal((await first.state()).trackId, "lifecycle-track");
  first.offline = true;
  await waitFor(() => device.status.connection === "disconnected");
  first.offline = false;
  await waitFor(() => device.status.connection === "connected");
  assert.equal((await post({ address: second.url, enabled: true })).status, 400);
  assert.equal((await post({ address: second.url, token: second.token, enabled: true })).status, 400);
  await device.configure({ address: second.url, token: second.token, enabled: true });
  await waitFor(() => device.status.connection === "connected");
  assert.equal((await second.state()).trackId, "lifecycle-track");
  await device.stop();
  const stopped = second.requests.length;
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  assert.equal(second.requests.length, stopped);
  device = new DeviceIntegration({ modeController, store, poller, intervalMs: 30 });
  await device.start();
  await waitFor(() => device.status.connection === "connected");
  assert.equal((await second.state()).trackId, "lifecycle-track");
  assert.ok(second.requests.length > stopped);
});

test("verified maintenance address is used only after identity recheck and the legacy record remains untouched", async () => {
  const legacy: DeviceConfig = { address: "http://192.168.1.20", token: "legacy-pairing-token", enabled: true };
  const store = new MemoryStore(); store.value = { ...legacy };
  const recovery: RecoveryCredential = { version: 1, token: "a".repeat(64), deviceId: "esp8266-a1b2c3", profile: "esp8266-dio40-4mb",
    recoveryIdentityFingerprint: "b".repeat(64), lastVerifiedAddress: "http://192.168.1.99" };
  const recoveryStore: RecoveryCredentialStore = { get: async () => recovery, set: async () => {}, delete: async () => {} };
  const poller = new PlaybackPoller({ provider: new MockSpotifyProvider(), pollIntervalMs: 15_000, now: () => EPOCH });
  const fetchDevice: typeof fetch = async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  let device = new DeviceIntegration({ modeController: await createTestModeController(), store, recoveryStore, poller, intervalMs: 30,
    fetchDevice,
    createMaintenanceClient: () => ({ info: async () => ({ deviceId: recovery.deviceId, bootId: "boot-01", buildId: "build-01",
      firmwareVersion: "0.1.0", stationIp: "192.168.1.99", recoveryApIp: "192.168.4.1", otaEnabled: true,
      maxFirmwareBytes: 458752, profile: recovery.profile, recoveryIdentityFingerprint: recovery.recoveryIdentityFingerprint }) }) });
  await device.start();
  assert.equal(device.status.address, recovery.lastVerifiedAddress);
  assert.deepEqual(store.value, legacy);
  await device.suspendAndDrain();
  await device.stop();

  device = new DeviceIntegration({ modeController: await createTestModeController(), store, recoveryStore, poller, intervalMs: 30,
    fetchDevice,
    createMaintenanceClient: () => ({ info: async () => ({ deviceId: recovery.deviceId, bootId: "boot-01", buildId: "build-01",
      firmwareVersion: "0.1.0", stationIp: "192.168.1.99", recoveryApIp: "192.168.4.1", otaEnabled: true,
      maxFirmwareBytes: 458752, profile: recovery.profile, recoveryIdentityFingerprint: recovery.recoveryIdentityFingerprint }) }) });
  device.holdForMaintenance();
  await device.start();
  assert.equal(device.status.address, recovery.lastVerifiedAddress);
  assert.equal(device.status.connection, "disabled");
  assert.deepEqual(store.value, legacy);
  device.resumeAfterExplicitRun();
  assert.equal(device.status.connection, "connecting");
  await device.stop();
});
