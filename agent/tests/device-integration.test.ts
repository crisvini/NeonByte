import assert from "node:assert/strict";
import test from "node:test";
import { DeviceIntegration, type DeviceConfig, type DeviceConfigStore } from "../src/device/integration.js";
import { PlaybackPoller } from "../src/spotify/poller.js";
import { startLocalWebApp } from "../src/web/server.js";
import { convertGifToAnimationV2 } from "../src/media/animation.js";

class MemoryStore implements DeviceConfigStore {
  value: DeviceConfig | null = null;
  async get() { return this.value; }
  async set(value: DeviceConfig) { this.value = { ...value }; }
}
const poller = () => new PlaybackPoller({ provider: { getCurrentPlayback: async () => null }, pollIntervalMs: 15000 });
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("GIF preparation never uploads automatically and an explicit replacement retries after removing the old animation", async () => {
  const asset = convertGifToAnimationV2(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64"));
  let freeStorageBytes = 0, uploads = 0, removals = 0, heartbeats = 0, supportsV2 = true;
  let uploadOffset = 0;
  const capabilities = { formats: ["nbif-v1", "nbif-v2"], width: 240, height: 240, maxFrames: 20, maxDurationMs: 30000,
    maxEncodedBytes: 2359296, maxChunkBytes: 1024, reserveBytes: 32768, get freeStorageBytes() { return freeStorageBytes; } };
  const device = new DeviceIntegration({ store: new MemoryStore(), poller: poller(), intervalMs: 10,
    fetchDevice: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      if (path === "/api/v1/status") return new Response(JSON.stringify({ protocolVersion: "v1", firmwareVersion: "test",
        ip: "127.0.0.1", freeStorageBytes, mode: "auto", activeScene: "gif" }));
      if (path === "/api/v2/media-capabilities") return supportsV2
        ? new Response(JSON.stringify(capabilities)) : new Response(null, { status: 404 });
      if (path === "/api/v2/animation" && method === "DELETE") {
        removals++;
        return new Response(JSON.stringify({ removed: true, freeStorageBytes }));
      }
      if (path === "/api/v2/animation/uploads" && method === "POST") {
        uploads++;
        uploadOffset = 0;
        return new Response(JSON.stringify({ uploadId: "aabbccdd", nextOffset: 0, state: "receiving" }), { status: 201 });
      }
      if (path.endsWith("/chunks")) {
        uploadOffset += Buffer.from(init?.body as Uint8Array).length;
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/complete")) return new Response(null, { status: 202 });
      if (path === "/api/v2/animation/uploads/aabbccdd") return new Response(JSON.stringify({ uploadId: "aabbccdd",
        state: "installed", nextOffset: uploadOffset, expectedBytes: asset.bytes.length, receivedBytes: uploadOffset, error: "" }));
      if (path.endsWith("/heartbeat")) heartbeats++;
      return new Response(null, { status: 204 });
    } });
  device.setAnimation(asset);
  await device.configure({ address: "http://127.0.0.1:1", token: "test-secret", enabled: true });
  try {
    await delay(80);
    assert.equal(device.status.animation.state, "prepared");
    assert.equal(removals, 0);
    assert.equal(uploads, 0);
    assert.ok(heartbeats >= 2);
    assert.equal(device.status.connection, "connected");
    device.replaceAnimation();
    await delay(80);
    assert.equal(device.status.animation.state, "failed");
    assert.equal(device.status.animation.previousAnimation, "removed");
    assert.match(device.status.animation.message, /previous animation was removed and was not preserved/i);
    assert.equal(removals, 1);
    assert.equal(uploads, 0);
    device.setAnimation(asset);
    assert.equal(device.status.animation.state, "prepared");
    assert.equal(device.status.animation.previousAnimation, "removed");
    supportsV2 = false;
    device.replaceAnimation();
    await delay(80);
    assert.equal(device.status.animation.state, "failed");
    assert.equal(device.status.animation.previousAnimation, "removed");
    assert.match(device.status.animation.message, /previous animation was removed and was not preserved/i);
    assert.equal(removals, 1, "incompatible firmware must not receive another destructive request");
    supportsV2 = true;
    freeStorageBytes = asset.bytes.length + 32768;
    device.replaceAnimation();
    await delay(80);
    assert.equal(device.status.animation.state, "complete");
    assert.equal(uploads, 1);
    assert.equal(removals, 2);
    assert.equal(JSON.stringify(device.status).includes("test-secret"), false);
  } finally { await device.stop(); }
});

test("configuration requires explicit enable and safely restores it after restart", async () => {
  const store = new MemoryStore();
  let calls = 0;
  const fetchDevice: typeof fetch = async () => { calls++; return new Response("", { status: 503 }); };
  const device = new DeviceIntegration({ store, poller: poller(), intervalMs: 10, fetchDevice });
  await device.start();
  await delay(20);
  assert.equal(calls, 0);
  assert.equal(device.status.connection, "disabled");
  await device.configure({ address: "http://127.0.0.1:1234", token: "test-pairing", enabled: true });
  await delay(30);
  assert.ok(calls > 1);
  assert.equal(device.status.connection, "disconnected");
  await device.stop();
  const before = calls;
  await delay(20);
  assert.equal(calls, before);
  const restarted = new DeviceIntegration({ store, poller: poller(), intervalMs: 10, fetchDevice });
  await restarted.start();
  await delay(20);
  assert.ok(calls > before);
  await restarted.configure({ address: "http://127.0.0.1:1234", enabled: false });
  assert.equal(restarted.status.connection, "disabled");
  await restarted.stop();
  const disabled = new DeviceIntegration({ store, poller: poller(), intervalMs: 10, fetchDevice });
  await disabled.start();
  const afterDisable = calls;
  await delay(20);
  assert.equal(calls, afterDisable);
  await disabled.stop();
});

test("address changes require a new token and storage failures cannot leak secrets", async () => {
  const store = new MemoryStore();
  const device = new DeviceIntegration({ store, poller: poller(), intervalMs: 10 });
  await device.start();
  await device.configure({ address: "http://127.0.0.1:1", token: "test-secret", enabled: false });
  await assert.rejects(device.configure({ address: "http://127.0.0.1:2", enabled: true }), /pairing token/i);
  assert.equal(store.value?.address, "http://127.0.0.1:1");
  await assert.rejects(device.configure({ address: "http://user:password@example.com", token: "test-secret", enabled: true }));
  assert.equal(JSON.stringify(device.status).includes("test-secret"), false);
  await device.stop();
});

test("dashboard protects configuration and never returns pairing credentials", async () => {
  const store = new MemoryStore();
  const device = new DeviceIntegration({ store, poller: poller(), intervalMs: 10 });
  await device.start();
  await device.configure({ address: "http://127.0.0.1:1", token: "test-secret", enabled: false });
  const app = await startLocalWebApp({ poller: poller(), oauth: null, spotifyConfigured: false,
    getDemoEnabled: () => true, setDemoEnabled: async () => {}, onMockAction: async () => {}, port: 0, device });
  const origin = `http://127.0.0.1:${app.port}`;
  try {
    const payload = JSON.stringify({ address: "http://127.0.0.1:1", enabled: true });
    const denied = await fetch(`${origin}/api/device`, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
    assert.equal(denied.status, 403);
    const accepted = await fetch(`${origin}/api/device`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: payload });
    assert.equal(accepted.status, 204);
    const state = await fetch(`${origin}/api/status`).then((r) => r.text());
    assert.equal(state.includes("test-secret"), false);
    assert.match(state, /127\.0\.0\.1:1/);
    const tokenPayload = await fetch(`${origin}/api/device`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ address: "http://127.0.0.1:1", token: "test-secret", enabled: true }) });
    assert.equal(tokenPayload.status, 400);
    assert.equal((await tokenPayload.text()).includes("test-secret"), false);
    const invalid = await fetch(`${origin}/api/device`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ address: "bad test-secret", enabled: true }) });
    assert.ok(invalid.status >= 400);
    assert.equal((await invalid.text()).includes("test-secret"), false);
  } finally { await app.close(); await device.stop(); }
});

test("credential-manager failures are safe and do not start a connection", async () => {
  let calls = 0;
  const store: DeviceConfigStore = { get: async () => null, set: async () => { throw new Error("test-secret"); } };
  const device = new DeviceIntegration({ store, poller: poller(), intervalMs: 10,
    fetchDevice: async () => { calls++; throw new Error("unexpected"); } });
  await device.start();
  await assert.rejects(device.configure({ address: "http://127.0.0.1:1", token: "test-secret", enabled: true }),
    (error: Error) => /credential manager/.test(error.message) && !error.message.includes("test-secret"));
  await delay(20);
  assert.equal(calls, 0);
  assert.equal(device.status.connection, "disabled");
  await device.stop();
});

test("shutdown during a configuration write never starts a new scheduler", async () => {
  let release!: () => void;
  let writing!: () => void;
  const started = new Promise<void>((resolve) => { writing = resolve; });
  const store: DeviceConfigStore = { get: async () => null, set: async () => {
    writing(); await new Promise<void>((resolve) => { release = resolve; });
  } };
  let calls = 0;
  const device = new DeviceIntegration({ store, poller: poller(), intervalMs: 10,
    fetchDevice: async () => { calls++; throw new Error("unexpected"); } });
  await device.start();
  const configuring = device.configure({ address: "http://127.0.0.1:1", token: "test-secret", enabled: true });
  await started;
  const stopping = device.stop();
  release();
  await configuring;
  await stopping;
  assert.equal(calls, 0);
});

test("configuration cannot restart the scheduler while the integration is held for maintenance", async () => {
  const store = new MemoryStore();
  let calls = 0;
  const device = new DeviceIntegration({ store, poller: poller(), intervalMs: 10,
    fetchDevice: async () => { calls++; return new Response("", { status: 503 }); } });
  await device.start();
  try {
    await device.configure({ address: "http://192.168.1.20", token: "test-secret", enabled: true });
    await delay(25);
    await device.suspendAndDrain();
    const drainedCalls = calls;
    await device.configure({ address: "http://192.168.1.20", enabled: true });
    await delay(25);
    assert.equal(calls, drainedCalls);
  } finally { await device.stop(); }
});
