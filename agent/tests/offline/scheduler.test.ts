import assert from "node:assert/strict";
import test from "node:test";
import { DeviceClient, DeviceSynchronizer } from "../../src/device/client.js";
import { DeviceScheduler } from "../../src/device/scheduler.js";
import { MockSpotifyProvider } from "../../src/spotify/mock.js";
import { PlaybackPoller } from "../../src/spotify/poller.js";
import { EPOCH, startHarness } from "./harness.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for synchronization.");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("scheduler reconnects to the native firmware after a network failure", async (t) => {
  const harness = await startHarness(t);
  const poller = new PlaybackPoller({ provider: new MockSpotifyProvider({
    is_playing: true, progress_ms: 1000,
    item: { type: "track", id: "scheduler-track", name: "Scheduler Track", duration_ms: 180000,
      artists: [{ name: "Test Artist" }], album: { images: [] } },
  }), pollIntervalMs: 15000, now: () => EPOCH });
  await poller.pollOnce();
  const synchronizer = new DeviceSynchronizer({ client: new DeviceClient({ baseUrl: harness.url, token: harness.token }), poller });
  const scheduler = new DeviceScheduler({ intervalMs: 30, synchronize: () => synchronizer.synchronize() });
  t.after(() => scheduler.stop());
  const before = harness.requests.length;
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.equal(harness.requests.length, before);
  scheduler.start();
  await waitFor(() => scheduler.status === "connected");
  assert.equal((await harness.state()).trackId, "scheduler-track");
  harness.offline = true;
  await waitFor(() => scheduler.status === "disconnected");
  harness.offline = false;
  await waitFor(() => scheduler.status === "connected");
  assert.equal((await harness.state()).trackId, "scheduler-track");
  await scheduler.stop();
});
