import assert from "node:assert/strict";
import test from "node:test";
import { DeviceIntegration, type DeviceConfig, type DeviceConfigStore } from "../../src/device/integration.js";
import { DisplayModeController } from "../../src/device/mode-controller.js";
import { MockSpotifyProvider } from "../../src/spotify/mock.js";
import { PlaybackPoller } from "../../src/spotify/poller.js";
import { MemoryDisplayModeStore } from "../helpers/mode-state.js";
import { startHarness } from "./harness.js";

class MemoryDeviceStore implements DeviceConfigStore {
  value: DeviceConfig | null = null;
  async get() { return this.value ? { ...this.value } : null; }
  async set(value: DeviceConfig) { this.value = { ...value }; }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("USD synchronization did not resume.");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("USD snapshots resynchronize after device and agent restarts without a status readback route", async (t) => {
  const harness = await startHarness(t);
  const localModeStore = new MemoryDisplayModeStore();
  localModeStore.state = { version: 1, mode: "auto", usdEnabled: true, revision: 0, pendingCommand: null };
  const deviceStore = new MemoryDeviceStore();
  const poller = new PlaybackPoller({ provider: new MockSpotifyProvider(), pollIntervalMs: 15_000 });
  const quoteService = { deviceState: () => ({ enabled: true, priceCents: 525, changeBasisPoints: 42, validForMs: 300_000 }) };
  const createModeController = async () => {
    const controller = new DisplayModeController(localModeStore, "auto");
    await controller.initialize();
    return controller;
  };
  let device = new DeviceIntegration({ modeController: await createModeController(), store: deviceStore,
    poller, intervalMs: 40, usdQuoteService: quoteService });
  t.after(async () => { await device.stop(); });
  await device.configure({ address: harness.url, token: harness.token, enabled: true });
  await waitFor(() => harness.requests.some(({ path }) => path === "/api/v1/usd-state"));
  assert.equal((await harness.state()).scene, "gif");

  const beforeDeviceRestart = harness.requests.filter(({ path }) => path === "/api/v1/usd-state").length;
  await harness.restart();
  await waitFor(() => harness.requests.filter(({ path }) => path === "/api/v1/usd-state").length > beforeDeviceRestart);

  await device.stop();
  const beforeAgentRestart = harness.requests.filter(({ path }) => path === "/api/v1/usd-state").length;
  device = new DeviceIntegration({ modeController: await createModeController(), store: deviceStore,
    poller, intervalMs: 40, usdQuoteService: quoteService });
  await device.start();
  await waitFor(() => harness.requests.filter(({ path }) => path === "/api/v1/usd-state").length > beforeAgentRestart);
  assert.equal(device.status.connection, "connected");
});
