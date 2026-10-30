import assert from "node:assert/strict";
import test from "node:test";
import { DeviceIntegration, type DeviceConfig, type DeviceConfigStore } from "../src/device/integration.js";
import { createTestModeController } from "./helpers/mode-state.js";
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
  const device = new DeviceIntegration({ modeController: await createTestModeController(), store: new MemoryStore(), poller: poller(), intervalMs: 10,
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

test("the prepared NBIF v2 remains available after a lost DELETE receipt and retries without conversion", async () => {
  const asset = convertGifToAnimationV2(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64"));
  let freeStorageBytes = 0;
  let removals = 0;
  let uploads = 0;
  let installed = true;
  const capabilities = { formats: ["nbif-v1", "nbif-v2"], width: 240, height: 240, maxFrames: 20, maxDurationMs: 30000,
    maxEncodedBytes: 2359296, maxChunkBytes: 1024, reserveBytes: 32768, get freeStorageBytes() { return freeStorageBytes; } };
  const device = new DeviceIntegration({ modeController: await createTestModeController(), store: new MemoryStore(), poller: poller(), intervalMs: 1000,
    fetchDevice: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      if (path === "/api/v1/status") return new Response(JSON.stringify({ protocolVersion: "v1", firmwareVersion: "test",
        ip: "127.0.0.1", freeStorageBytes, mode: "auto", activeScene: "gif" }));
      if (path === "/api/v2/media-capabilities") return new Response(JSON.stringify(capabilities));
      if (path === "/api/v2/animation" && method === "DELETE") {
        removals++;
        installed = false;
        freeStorageBytes = asset.bytes.length + capabilities.reserveBytes;
        if (removals === 1) {
          return new Response(new ReadableStream<Uint8Array>({ start(controller) {
            controller.enqueue(new TextEncoder().encode('{"removed":true,"freeStorageBytes":'));
            controller.error(new Error("simulated close after deletion"));
          } }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ removed: true, freeStorageBytes }));
      }
      if (path === "/api/v2/animation/uploads" && method === "POST") {
        assert.equal(installed, false);
        const begin = JSON.parse(String(init?.body));
        assert.deepEqual(begin, { sizeBytes: asset.bytes.length, sha256: asset.sha256 });
        uploads++;
        return new Response(JSON.stringify({ uploadId: "aabbccdd", nextOffset: 0, state: "receiving" }), { status: 201 });
      }
      if (path.endsWith("/chunks")) return new Response(null, { status: 204 });
      if (path.endsWith("/complete")) return new Response(null, { status: 202 });
      if (path === "/api/v2/animation/uploads/aabbccdd") return new Response(JSON.stringify({ uploadId: "aabbccdd",
        state: "installed", nextOffset: asset.bytes.length, expectedBytes: asset.bytes.length,
        receivedBytes: asset.bytes.length, error: "" }));
      return new Response(null, { status: 204 });
    } });
  device.setAnimation(asset);
  await device.configure({ address: "http://127.0.0.1:1", token: "test-secret", enabled: true });
  try {
    device.replaceAnimation();
    await delay(50);
    assert.equal(device.status.animation.state, "failed");
    assert.equal(device.status.animation.previousAnimation, "unknown");
    assert.match(device.status.animation.message, /HTTP 200.*connection closed.*receipt/i);
    assert.equal(removals, 1);
    assert.equal(uploads, 0);

    device.replaceAnimation();
    await delay(80);
    assert.equal(device.status.animation.state, "complete");
    assert.equal(device.status.animation.previousAnimation, "removed");
    assert.equal(removals, 2, "retry repeats DELETE safely after the first removal response was lost");
    assert.equal(uploads, 1, "the prepared NBIF v2 is uploaded without choosing or converting the GIF again");
  } finally { await device.stop(); }
});

test("configuration requires explicit enable and safely restores it after restart", async () => {
  const store = new MemoryStore();
  let calls = 0;
  const fetchDevice: typeof fetch = async () => { calls++; return new Response("", { status: 503 }); };
  const device = new DeviceIntegration({ modeController: await createTestModeController(), store, poller: poller(), intervalMs: 10, fetchDevice });
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
  const restarted = new DeviceIntegration({ modeController: await createTestModeController(), store, poller: poller(), intervalMs: 10, fetchDevice });
  await restarted.start();
  await delay(20);
  assert.ok(calls > before);
  await restarted.configure({ address: "http://127.0.0.1:1234", enabled: false });
  assert.equal(restarted.status.connection, "disabled");
  await restarted.stop();
  const disabled = new DeviceIntegration({ modeController: await createTestModeController(), store, poller: poller(), intervalMs: 10, fetchDevice });
  await disabled.start();
  const afterDisable = calls;
  await delay(20);
  assert.equal(calls, afterDisable);
  await disabled.stop();
});

test("Spotify refreshes, GIF preparation, and reconnects never write the device mode", async () => {
  const modeController = await createTestModeController();
  let deviceMode = "auto";
  let offline = false;
  let spotifyUnavailable = false;
  let playback: { is_playing: boolean; progress_ms: number; item: { type: string; id: string; name: string; duration_ms: number; artists: { name: string }[]; album: { images: [] } } } | null = null;
  const modeWrites: string[] = [];
  const playbackPoller = new PlaybackPoller({ provider: { getCurrentPlayback: async () => {
    if (spotifyUnavailable) throw new Error("test fixture network outage");
    return playback;
  } }, pollIntervalMs: 15_000 });
  await playbackPoller.pollOnce();
  const device = new DeviceIntegration({ modeController, store: new MemoryStore(), poller: playbackPoller, intervalMs: 10,
    fetchDevice: async (input, init) => {
      if (offline) return new Response(null, { status: 503 });
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/status") return new Response(JSON.stringify({ protocolVersion: "v1", firmwareVersion: "test",
        ip: "127.0.0.1", freeStorageBytes: 65536, mode: deviceMode, activeScene: deviceMode === "spotify" ? "spotify" : "gif" }));
      if (path === "/api/v1/mode" && init?.method === "PUT") {
        deviceMode = JSON.parse(String(init.body)).mode as string;
        modeWrites.push(deviceMode);
      }
      return new Response(null, { status: 204 });
    } });

  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("Device mode synchronization did not settle.");
      await delay(10);
    }
  };

  await device.configure({ address: "http://127.0.0.1:1", token: "test-pairing", enabled: true });
  try {
    await waitFor(() => device.status.connection === "connected");
    assert.deepEqual(modeWrites, [], "pairing and initial status reads do not apply a locally restored selection");

    playback = { is_playing: true, progress_ms: 1000, item: { type: "track", id: "real-state", name: "Current Track",
      duration_ms: 180000, artists: [{ name: "Current Artist" }], album: { images: [] } } };
    await playbackPoller.pollOnce();
    const asset = convertGifToAnimationV2(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64"));
    device.setAnimation(asset);
    await delay(35);
    assert.deepEqual(modeWrites, [], "Spotify metadata refresh and GIF preparation do not write the mode endpoint");
    assert.equal(modeController.selectedMode, "auto");

    await modeController.selectManual("gif", device.modeTargetFingerprint);
    device.requestModeSynchronization();
    await waitFor(() => modeController.view.syncState === "confirmed");
    assert.deepEqual(modeWrites, ["gif"], "only the explicit selection sends a mode command");

    spotifyUnavailable = true;
    await playbackPoller.pollOnce();
    assert.equal(modeController.selectedMode, "gif");
    assert.deepEqual(modeWrites, ["gif"], "Spotify failure does not change the selected or device mode");
    spotifyUnavailable = false;
    await playbackPoller.pollOnce();
    await delay(25);
    assert.deepEqual(modeWrites, ["gif"], "Spotify recovery does not send another mode command");

    offline = true;
    await waitFor(() => device.status.connection === "disconnected");
    offline = false;
    await waitFor(() => device.status.connection === "connected");
    await delay(35);
    assert.deepEqual(modeWrites, ["gif"], "reconnection observes the mode without reapplying it");
    assert.equal(modeController.selectedMode, "gif");
  } finally { await device.stop(); }
});

test("dashboard verifies a saved token at a new address and resumes synchronization", async () => {
  const store = new MemoryStore();
  store.value = { address: "http://192.168.68.72", token: "test-secret", enabled: true };
  const addresses: string[] = [];
  const fetchDevice: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/status") return new Response(JSON.stringify({ protocolVersion: "v1", firmwareVersion: "test",
      ip: url.hostname, freeStorageBytes: 65536, mode: "auto", activeScene: "gif" }));
    if (url.pathname === "/api/v1/heartbeat" && new Headers(init?.headers).get("Authorization") === "Bearer test-secret") {
      addresses.push(url.hostname);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 401 });
  };
  const modeController = await createTestModeController();
  const device = new DeviceIntegration({ modeController, store, poller: poller(), intervalMs: 20, fetchDevice });
  await device.start();
  const app = await startLocalWebApp({ poller: poller(), modeController, oauth: null, spotifyConfigured: false, port: 0, device });
  const origin = `http://127.0.0.1:${app.port}`;
  try {
    const response = await fetch(`${origin}/api/device`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ address: "http://192.168.68.65", enabled: true }) });
    assert.equal(response.status, 204);
    assert.deepEqual(store.value, { address: "http://192.168.68.65", token: "test-secret", enabled: true });
    const deadline = Date.now() + 2000;
    while (device.status.connection !== "connected" || addresses.filter((address) => address === "192.168.68.65").length < 2) {
      if (Date.now() >= deadline) throw new Error("Device did not synchronize at the new address.");
      await delay(10);
    }
    assert.equal((await fetch(`${origin}/api/status`).then((result) => result.text())).includes("test-secret"), false);
  } finally { await app.close(); await device.stop(); }
});

test("failed address validation preserves the saved configuration and never exposes the token", async () => {
  const initial = { address: "http://192.168.68.72", token: "test-secret", enabled: true };
  const store = new MemoryStore(); store.value = { ...initial };
  let failure: "reject" | "offline" | "none" = "reject";
  const fetchDevice: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "192.168.68.65" && failure === "offline") throw new Error("test-secret");
    if (url.pathname === "/api/v1/status") return new Response(JSON.stringify({ protocolVersion: "v1", firmwareVersion: "test",
      ip: url.hostname, freeStorageBytes: 65536, mode: "auto", activeScene: "gif" }));
    if (url.hostname === "192.168.68.65" && failure === "reject") return new Response("test-secret", { status: 401 });
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-secret");
    return new Response(null, { status: 204 });
  };
  const modeController = await createTestModeController();
  const device = new DeviceIntegration({ modeController, store, poller: poller(), intervalMs: 20, fetchDevice });
  await device.start();
  const app = await startLocalWebApp({ poller: poller(), modeController, oauth: null, spotifyConfigured: false, port: 0, device });
  const origin = `http://127.0.0.1:${app.port}`;
  const post = (address: string) => fetch(`${origin}/api/device`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ address, enabled: true }) });
  try {
    for (const scenario of ["reject", "offline"] as const) {
      failure = scenario;
      const response = await post("http://192.168.68.65");
      assert.equal(response.status, 400);
      const body = await response.text();
      assert.match(body, /pairing|communication|connectivity/i);
      assert.equal(body.includes("test-secret"), false);
      assert.deepEqual(store.value, initial);
      assert.equal(device.status.address, initial.address);
    }
    const invalid = await post("http://user:password@example.com");
    assert.equal(invalid.status, 400);
    assert.deepEqual(store.value, initial);
    assert.equal(JSON.stringify(device.status).includes("test-secret"), false);
    const deadline = Date.now() + 2000;
    while (device.status.connection !== "connected") {
      if (Date.now() >= deadline) throw new Error("Previous connection did not resume.");
      await delay(10);
    }
  } finally { await app.close(); await device.stop(); }
});

test("a missing stored token rejects an address change without replacing the previous configuration", async () => {
  const store = new MemoryStore();
  store.value = { address: "http://192.168.68.72", token: "test-secret", enabled: false };
  const device = new DeviceIntegration({ modeController: await createTestModeController(), store, poller: poller(), intervalMs: 20 });
  await device.start();
  store.value = null;
  try {
    await assert.rejects(device.configure({ address: "http://192.168.68.65", enabled: true }), /pairing token/i);
    assert.equal(store.value, null);
    assert.equal(device.status.address, "http://192.168.68.72");
  } finally { await device.stop(); }
});

test("a failed credential write keeps the previous connection active", async () => {
  const initial = { address: "http://192.168.68.72", token: "test-secret", enabled: true };
  const store: DeviceConfigStore = { get: async () => ({ ...initial }), set: async () => { throw new Error("test-secret"); } };
  const fetchDevice: typeof fetch = async (input) => {
    const url = new URL(String(input));
    return url.pathname === "/api/v1/status"
      ? new Response(JSON.stringify({ protocolVersion: "v1", firmwareVersion: "test", ip: url.hostname,
        freeStorageBytes: 65536, mode: "auto", activeScene: "gif" }))
      : new Response(null, { status: 204 });
  };
  const device = new DeviceIntegration({ modeController: await createTestModeController(), store, poller: poller(), intervalMs: 20, fetchDevice });
  await device.start();
  try {
    await assert.rejects(device.configure({ address: "http://192.168.68.65", enabled: true }),
      (error: Error) => /credential manager/.test(error.message) && !error.message.includes("test-secret"));
    assert.equal(device.status.address, initial.address);
    const deadline = Date.now() + 2000;
    while (device.status.connection !== "connected") {
      if (Date.now() >= deadline) throw new Error("Previous connection did not resume.");
      await delay(10);
    }
  } finally { await device.stop(); }
});

test("credential read errors are sanitized when updating an address", async () => {
  let failRead = false;
  const store: DeviceConfigStore = {
    get: async () => { if (failRead) throw new Error("credential manager: test-secret");
      return { address: "http://192.168.68.72", token: "test-secret", enabled: false }; },
    set: async () => { throw new Error("Unexpected write."); },
  };
  const modeController = await createTestModeController();
  const device = new DeviceIntegration({ modeController, store, poller: poller(), intervalMs: 20 });
  await device.start();
  failRead = true;
  const app = await startLocalWebApp({ poller: poller(), modeController, oauth: null, spotifyConfigured: false, port: 0, device });
  const origin = `http://127.0.0.1:${app.port}`;
  try {
    const response = await fetch(`${origin}/api/device`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ address: "http://192.168.68.65", enabled: true }) });
    assert.equal(response.status, 400);
    const body = await response.text();
    assert.match(body, /credential manager/i);
    assert.equal(body.includes("test-secret"), false);
    assert.equal(device.status.address, "http://192.168.68.72");
  } finally { await app.close(); await device.stop(); }
});

test("dashboard protects configuration and never returns pairing credentials", async () => {
  const store = new MemoryStore();
  const modeController = await createTestModeController();
  const device = new DeviceIntegration({ modeController, store, poller: poller(), intervalMs: 10 });
  await device.start();
  await device.configure({ address: "http://127.0.0.1:1", token: "test-secret", enabled: false });
  const app = await startLocalWebApp({ poller: poller(), modeController, oauth: null, spotifyConfigured: false, port: 0, device });
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
  const device = new DeviceIntegration({ modeController: await createTestModeController(), store, poller: poller(), intervalMs: 10,
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
  const device = new DeviceIntegration({ modeController: await createTestModeController(), store, poller: poller(), intervalMs: 10,
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
  const device = new DeviceIntegration({ modeController: await createTestModeController(), store, poller: poller(), intervalMs: 10,
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
