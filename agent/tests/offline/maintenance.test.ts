import assert from "node:assert/strict";
import test from "node:test";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startHarness } from "./harness.js";

interface MaintenanceState {
  storageAvailable: boolean; configurationLoaded: boolean; applicationRunning: boolean;
  recoveryApRunning: boolean; stationConnected: boolean; pendingWifi: boolean; volatileWifi: boolean;
}

test("provisioning requires authentication, fresh association, and confirmation before persisting", async (t) => {
  const harness = await startHarness(t, { bootstrap: false });
  const status = async () => (await harness.maintenance("status")).json() as Promise<MaintenanceState>;
  assert.equal((await harness.state()).calls, "NH");
  assert.equal((await harness.maintenance("status", undefined, "wrong")).status, 401);
  assert.equal((await harness.maintenance("wifi", "ssid=Lab&password=short")).status, 400);
  assert.equal((await harness.maintenance("wifi", "ssid=Lab&password=test-password")).status, 204);
  assert.equal((await harness.state()).savedSsid, "");
  assert.equal((await harness.maintenance("wifi/confirm")).status, 409);
  await harness.associate("Wrong");
  assert.equal((await harness.maintenance("wifi/confirm")).status, 409);
  await harness.associate("Lab");
  assert.equal((await harness.maintenance("wifi/confirm")).status, 204);
  assert.equal((await harness.state()).savedSsid, "Lab");
  assert.equal((await status()).recoveryApRunning, true);
  assert.equal((await harness.maintenance("run")).status, 204);
  assert.equal((await status()).applicationRunning, true);
  assert.equal((await harness.maintenance("wifi", "ssid=Lab&password=changed-password")).status, 204);
  assert.equal((await harness.maintenance("wifi/confirm")).status, 409);
  await harness.advance(29_999); assert.equal((await harness.state()).attempts, 2);
  await harness.advance(1); assert.equal((await harness.state()).attempts, 3);
  await harness.associate("Lab");
  assert.equal((await harness.maintenance("wifi/confirm")).status, 204);
  assert.equal((await status()).recoveryApRunning, true);
});

test("storage and application failures keep authenticated maintenance available and temporary Wi-Fi disappears on restart", async (t) => {
  const harness = await startHarness(t);
  assert.equal((await harness.maintenance("pause")).status, 204);
  assert.equal((await fetch(`${harness.url}/api/v1/status`)).status, 409);
  await harness.fault("app", false);
  assert.equal((await harness.maintenance("run")).status, 500);
  let status = await (await harness.maintenance("status")).json() as MaintenanceState;
  assert.equal(status.applicationRunning, false); assert.equal(status.recoveryApRunning, true);
  await harness.fault("app", true);
  assert.equal((await harness.maintenance("run")).status, 204);
  await harness.fault("write", false);
  await harness.maintenance("wifi", "ssid=NewLab&password=new-password"); await harness.associate("NewLab");
  assert.equal((await harness.maintenance("wifi/confirm")).status, 409);
  assert.equal((await harness.state()).savedSsid, "OfflineLab");
  status = await (await harness.maintenance("status")).json() as MaintenanceState;
  assert.equal(status.pendingWifi, true); assert.equal(status.volatileWifi, false);
  await harness.maintenance("wifi/temporary", "ssid=TemporaryLab&password=temp-password"); await harness.associate("TemporaryLab");
  assert.equal((await harness.maintenance("wifi/confirm")).status, 204);
  assert.equal(((await (await harness.maintenance("status")).json()) as MaintenanceState).volatileWifi, true);
  await harness.restart(false);
  status = await (await harness.maintenance("status")).json() as MaintenanceState;
  assert.equal(status.volatileWifi, false); assert.equal(status.applicationRunning, false);
  await harness.fault("mount", false);
  assert.equal((await harness.maintenance("storage")).status, 409);
  await harness.maintenance("wifi/temporary", "ssid=RamOnly&password=temp-password"); await harness.associate("RamOnly");
  assert.equal((await harness.maintenance("wifi/confirm")).status, 204);
  assert.equal((await harness.maintenance("run")).status, 409);
  await harness.fault("mount", true);
  assert.equal((await harness.maintenance("storage")).status, 204);
  assert.equal((await harness.state()).applicationRunning, false);
  assert.equal((await harness.state()).savedSsid, "OfflineLab");
  assert.equal((await harness.maintenance("run")).status, 204);
});

test("crash-start maintenance avoids automatic storage and display access, rejects firmware changes, and never echoes credentials", async (t) => {
  const harness = await startHarness(t, { bootstrap: false });
  await harness.advance(90_000);
  const state = await harness.state(); assert.equal(state.applicationRunning, false);
  assert.ok(!state.calls.includes("F")); assert.ok(!state.calls.includes("A"));
  const response = await harness.maintenance("status");
  const text = await response.text(); assert.ok(!text.includes(harness.token)); assert.ok(!text.includes("password"));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await harness.maintenance("firmware", "unavailable")).status, 409);
  assert.equal((await harness.maintenance("run", undefined, "wrong")).status, 401);
  assert.equal((await harness.maintenance("wifi", "ssid=Lab&password=%00bad-password")).status, 400);
});

test("crash-start maintenance leaves staged disk files untouched until explicit storage preparation", async (t) => {
  const harness = await startHarness(t, { bootstrap: false });
  await writeFile(join(harness.directory, "animation.part"), "incomplete test candidate");
  await harness.restart(false); await harness.advance(60_000);
  assert.equal((await harness.maintenance("status")).status, 200);
  assert.ok((await readdir(harness.directory)).includes("animation.part"));
  assert.equal((await harness.maintenance("storage")).status, 204);
  assert.ok(!(await readdir(harness.directory)).includes("animation.part"));
});
