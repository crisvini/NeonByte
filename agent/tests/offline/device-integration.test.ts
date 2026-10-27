import assert from "node:assert/strict";
import test from "node:test";
import { DeviceIntegration, type DeviceConfig, type DeviceConfigStore } from "../../src/device/integration.js";
import { PlaybackPoller } from "../../src/spotify/poller.js";
import { MockSpotifyProvider } from "../../src/spotify/mock.js";
import { startLocalWebApp } from "../../src/web/server.js";
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
  let device = new DeviceIntegration({ store, poller, intervalMs: 30 });
  await device.start();
  const app = await startLocalWebApp({ poller, device, oauth: null, spotifyConfigured: false,
    getDemoEnabled: () => true, setDemoEnabled: async () => {}, onMockAction: async () => {}, port: 0 });
  t.after(async () => { await app.close(); await device.stop(); });
  const origin = `http://127.0.0.1:${app.port}`;
  const post = (data: unknown) => fetch(`${origin}/api/device`, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const before = first.requests.length;
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.equal(first.requests.length, before);
  assert.equal((await post({ address: first.url, token: first.token, enabled: true })).status, 204);
  await waitFor(() => device.status.connection === "connected");
  assert.equal((await first.state()).trackId, "lifecycle-track");
  first.offline = true;
  await waitFor(() => device.status.connection === "disconnected");
  first.offline = false;
  await waitFor(() => device.status.connection === "connected");
  assert.equal((await post({ address: second.url, enabled: true })).status, 400);
  assert.equal((await post({ address: second.url, token: second.token, enabled: true })).status, 204);
  await waitFor(() => device.status.connection === "connected");
  assert.equal((await second.state()).trackId, "lifecycle-track");
  await device.stop();
  const stopped = second.requests.length;
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  assert.equal(second.requests.length, stopped);
  device = new DeviceIntegration({ store, poller, intervalMs: 30 });
  await device.start();
  await waitFor(() => device.status.connection === "connected");
  assert.equal((await second.state()).trackId, "lifecycle-track");
  assert.ok(second.requests.length > stopped);
});
