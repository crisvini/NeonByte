import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { DeviceIntegration, type DeviceConfig, type DeviceConfigStore } from "../../src/device/integration.js";
import { createTestModeController } from "../helpers/mode-state.js";
import { PlaybackPoller } from "../../src/spotify/poller.js";
import { MockSpotifyProvider } from "../../src/spotify/mock.js";
import { startLocalWebApp } from "../../src/web/server.js";
import { EPOCH, startHarness } from "./harness.js";

class Store implements DeviceConfigStore {
  value: DeviceConfig | null = null;
  async get() { return this.value; }
  async set(value: DeviceConfig) { this.value = value; }
}
async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 4000;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error("Timed out waiting for media synchronization.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
test("dashboard prepares a validated GIF locally and requires compatible v2 firmware before replacement", async (t) => {
  const harness = await startHarness(t);
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#ff0000" } }).png().toBuffer();
  const poller = new PlaybackPoller({ provider: new MockSpotifyProvider({ is_playing: true, progress_ms: 100,
    item: { type: "track", id: "media-track", name: "Media", duration_ms: 180000,
      artists: [{ name: "Artist" }], album: { images: [{ url: "https://i.scdn.co/test" }] } } }), pollIntervalMs: 15000, now: () => EPOCH });
  await poller.pollOnce();
  const modeController = await createTestModeController();
  const device = new DeviceIntegration({ modeController, store: new Store(), poller, intervalMs: 30,
    fetchCover: async () => new Response(png, { headers: { "Content-Type": "image/png" } }) });
  await device.start();
  await device.configure({ address: harness.url, token: harness.token, enabled: false });
  const app = await startLocalWebApp({ poller, modeController, device, oauth: null, spotifyConfigured: false, port: 0 });
  t.after(async () => { await app.close(); await device.stop(); });
  const origin = `http://127.0.0.1:${app.port}`;
  const post = (path: string, body: unknown) => fetch(`${origin}${path}`, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post("/api/device", { address: harness.url, enabled: true })).status, 204);
  await waitFor(() => device.status.connection === "connected");
  await waitFor(async () => (await harness.state()).coverPixel === 0xf800);
  const count = harness.requests.filter((r) => r.path === "/api/v1/cover").length;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(harness.requests.filter((r) => r.path === "/api/v1/cover").length, count);
  assert.equal((await post("/api/mode", { mode: "gif" })).status, 204);
  await waitFor(() => harness.requests.some((r) => r.path === "/api/v1/mode"));
  await waitFor(() => device.status.mode === "gif");
  const selectedModeWrites = harness.requests.filter((r) => r.path === "/api/v1/mode").length;
  assert.equal((await harness.state()).scene, "gif");
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
  const converted = await fetch(`${origin}/api/animation`, { method: "POST", headers: { Origin: origin, "Content-Type": "image/gif" }, body: gif });
  assert.equal(converted.status, 201);
  const metadata = await converted.json() as { width: number; height: number; frameCount: number; durationMs: number; sizeBytes: number; sha256: string };
  assert.deepEqual({ width: metadata.width, height: metadata.height, frameCount: metadata.frameCount, durationMs: metadata.durationMs },
    { width: 240, height: 240, frameCount: 1, durationMs: 100 });
  assert.ok(metadata.sizeBytes > 0);
  assert.match(metadata.sha256, /^[0-9a-f]{64}$/);
  assert.equal(device.status.animation.state, "prepared");
  assert.equal((await harness.state()).animationFrames, 0);
  const statusAfterPreparation = await fetch(`${origin}/api/status`).then((response) => response.json()) as { mode: string; device: { mode: string } };
  assert.equal(statusAfterPreparation.mode, "gif");
  assert.equal(statusAfterPreparation.device.mode, "gif");
  assert.equal(harness.requests.filter((r) => r.path === "/api/v1/mode").length, selectedModeWrites,
    "preparing a GIF does not add a mode command");
  assert.equal(harness.requests.some(({ path }) => path.includes("/animation")), false,
    "GIF selection only prepares the converted candidate; it must not upload or remove anything");

  assert.equal((await fetch(`${origin}/api/animation/replace`, { method: "POST", headers: { Origin: origin } })).status, 202);
  await waitFor(() => device.status.animation.state === "failed");
  assert.match(device.status.animation.message, /does not support the authenticated NBIF v2 replacement workflow/i);
  assert.equal(device.status.animation.previousAnimation, "unchanged");
  assert.equal((await harness.state()).animationFrames, 0);
  assert.equal(harness.requests.some(({ path }) => path === "/api/v2/animation" || path.startsWith("/api/v2/animation/uploads")), false,
    "unsupported firmware must be rejected before the destructive removal request");
  assert.equal(harness.requests.some(({ path }) => path === "/api/v1/animation"), false,
    "the dashboard must never transfer the original GIF or use the legacy upload route");

  harness.offline = true;
  await waitFor(() => device.status.connection === "disconnected");
  await harness.restart(false);
  harness.offline = false;
  assert.equal((await harness.maintenance("run")).status, 204);
  await waitFor(() => device.status.connection === "connected");
  assert.equal((await harness.state()).animationFrames, 0);
  assert.equal((await harness.state()).scene, "gif");
  assert.equal(harness.requests.some(({ path }) => path === "/api/v1/animation"), false);
  assert.equal((await post("/api/mode", { mode: "spotify" })).status, 204);
  await waitFor(() => harness.requests.filter((r) => r.path === "/api/v1/mode").length >= 2);
  assert.equal((await harness.state()).coverPixel, 0xf800);
});

test("a slow cover download keeps native playback alive and schedules its ready artwork without waiting for the next interval", async (t) => {
  const harness = await startHarness(t);
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#ff0000" } }).png().toBuffer();
  const poller = new PlaybackPoller({ provider: new MockSpotifyProvider({ is_playing: true, progress_ms: 100,
    item: { type: "track", id: "slow-art", name: "Slow Artwork", duration_ms: 180000,
      artists: [{ name: "Artist" }], album: { images: [{ url: "https://i.scdn.co/test" }] } } }), pollIntervalMs: 15000, now: () => EPOCH });
  await poller.pollOnce();
  let release!: (response: Response) => void;
  let downloads = 0;
  const source = new Promise<Response>((resolve) => { release = resolve; });
  const device = new DeviceIntegration({ modeController: await createTestModeController(), store: new Store(), poller, intervalMs: 60000, fetchCover: async () => { downloads++; return source; } });
  t.after(async () => { release(new Response(png, { headers: { "Content-Type": "image/png" } })); await device.stop(); });
  await device.configure({ address: harness.url, token: harness.token, enabled: true });
  await waitFor(() => device.status.connection === "connected");
  assert.equal((await harness.state()).scene, "spotify");
  assert.equal((await harness.state()).agentAvailable, true);
  assert.equal(harness.requests.some(({ path }) => path === "/api/v1/cover"), false);
  for (let cycle = 0; cycle < 3; cycle++) {
    await device.configure({ address: harness.url, enabled: false });
    await device.configure({ address: harness.url, enabled: true });
    await waitFor(() => device.status.connection === "connected");
  }
  assert.equal(downloads, 1);
  release(new Response(png, { headers: { "Content-Type": "image/png" } }));
  await waitFor(() => {
    const index = harness.requests.findIndex(({ path }) => path === "/api/v1/cover");
    return index >= 0 && harness.requests.slice(index + 1).some(({ path }) => path === "/api/v1/heartbeat");
  });
  assert.equal((await harness.state()).coverPixel, 0xf800);
});
