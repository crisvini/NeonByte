import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { DeviceIntegration, type DeviceConfig, type DeviceConfigStore } from "../../src/device/integration.js";
import { PlaybackPoller } from "../../src/spotify/poller.js";
import { MockSpotifyProvider } from "../../src/spotify/mock.js";
import { startLocalWebApp } from "../../src/web/server.js";
import { EPOCH, startHarness } from "./harness.js";

class Store implements DeviceConfigStore {
  value: DeviceConfig | null = null;
  async get() { return this.value; }
  async set(value: DeviceConfig) { this.value = value; }
}
async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out waiting for media synchronization.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
test("dashboard mode, decoded artwork, and GIF reach the native device and retry safely", async (t) => {
  const harness = await startHarness(t);
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#ff0000" } }).png().toBuffer();
  const poller = new PlaybackPoller({ provider: new MockSpotifyProvider({ is_playing: true, progress_ms: 100,
    item: { type: "track", id: "media-track", name: "Media", duration_ms: 180000,
      artists: [{ name: "Artist" }], album: { images: [{ url: "https://i.scdn.co/test" }] } } }), pollIntervalMs: 15000, now: () => EPOCH });
  await poller.pollOnce();
  const device = new DeviceIntegration({ store: new Store(), poller, intervalMs: 30,
    fetchCover: async () => new Response(png, { headers: { "Content-Type": "image/png" } }) });
  await device.start();
  const app = await startLocalWebApp({ poller, device, oauth: null, spotifyConfigured: false,
    getDemoEnabled: () => false, setDemoEnabled: async () => {}, onMockAction: async () => {}, port: 0 });
  t.after(async () => { await app.close(); await device.stop(); });
  const origin = `http://127.0.0.1:${app.port}`;
  const post = (path: string, body: unknown) => fetch(`${origin}${path}`, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post("/api/device", { address: harness.url, token: harness.token, enabled: true })).status, 204);
  await waitFor(() => device.status.connection === "connected");
  assert.equal((await harness.state()).coverPixel, 0xf800);
  const count = harness.requests.filter((r) => r.path === "/api/v1/cover").length;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(harness.requests.filter((r) => r.path === "/api/v1/cover").length, count);
  assert.equal((await post("/api/mode", { mode: "gif" })).status, 204);
  await waitFor(() => harness.requests.some((r) => r.path === "/api/v1/mode"));
  assert.equal((await harness.state()).scene, "gif");
  await harness.fault("promote", false);
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  assert.equal((await fetch(`${origin}/api/animation`, { method: "POST", headers: { Origin: origin, "Content-Type": "image/gif" }, body: gif })).status, 201);
  await waitFor(() => device.status.animation.state === "retrying");
  assert.equal((await harness.state()).animationFrames, 0);
  await harness.fault("promote", true);
  await waitFor(() => device.status.animation.state === "complete");
  assert.equal((await harness.state()).animationFrames, 1);
  const uploads = harness.requests.filter((r) => r.path === "/api/v1/animation").length;
  assert.equal((await fetch(`${origin}/api/animation`, { method: "POST", headers: { Origin: origin, "Content-Type": "image/gif" }, body: gif })).status, 201);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(harness.requests.filter((r) => r.path === "/api/v1/animation").length, uploads);
  harness.offline = true;
  await waitFor(() => device.status.connection === "disconnected");
  await harness.restart(false);
  harness.offline = false;
  assert.equal((await harness.maintenance("run")).status, 204);
  await waitFor(() => device.status.connection === "connected");
  assert.equal((await harness.state()).animationFrames, 1);
  assert.equal((await harness.state()).scene, "gif");
  assert.equal(harness.requests.filter((r) => r.path === "/api/v1/animation").length, uploads);
  assert.equal((await post("/api/mode", { mode: "spotify" })).status, 204);
  await waitFor(() => harness.requests.filter((r) => r.path === "/api/v1/mode").length >= 2);
  assert.equal((await harness.state()).coverPixel, 0xf800);
});
