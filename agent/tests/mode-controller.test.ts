import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DisplayModeController, FileDisplayModeStore, modeTargetId } from "../src/device/mode-controller.js";

const firstPairing = "a".repeat(64);
const secondPairing = "b".repeat(64);

async function withStore(run: (store: FileDisplayModeStore) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "neonbyte-mode-"));
  try { await run(new FileDisplayModeStore(join(directory, "display-mode.json"))); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("an explicit selection persists across agent restart and awaits device observation", async () => {
  await withStore(async (store) => {
    const first = new DisplayModeController(store, "auto");
    await first.initialize();
    await first.selectManual("spotify", firstPairing);
    assert.equal(first.view.syncState, "pending");
    assert.equal((await first.pendingCommandFor(firstPairing))?.mode, "spotify");

    const restarted = new DisplayModeController(store, "auto");
    await restarted.initialize();
    assert.equal(restarted.selectedMode, "spotify");
    assert.equal((await restarted.pendingCommandFor(firstPairing))?.mode, "spotify");
    await restarted.observeDeviceMode("gif", firstPairing, 500);
    assert.equal(restarted.view.syncState, "pending");
    await restarted.observeDeviceMode("spotify", firstPairing, 1000);
    assert.equal(restarted.view.syncState, "confirmed");
    assert.equal(restarted.view.confirmedMode, "spotify");
    assert.equal(restarted.view.observedAtUnixMs, 1000);
    assert.equal(await restarted.pendingCommandFor(firstPairing), null);
  });
});

test("a local-only selection cannot be replayed onto a later paired device", async () => {
  await withStore(async (store) => {
    const controller = new DisplayModeController(store, "auto");
    await controller.initialize();
    await controller.selectManual("gif", null);
    assert.equal(controller.view.syncState, "local");

    const restarted = new DisplayModeController(store, "auto");
    await restarted.initialize();
    assert.equal(await restarted.pendingCommandFor(secondPairing), null);
    assert.equal(restarted.view.syncState, "local");
  });
});

test("observing Spotify or device state never changes the saved selection", async () => {
  await withStore(async (store) => {
    const controller = new DisplayModeController(store, "auto");
    await controller.initialize();
    await controller.selectManual("gif", null);
    await controller.observeDeviceMode("auto", firstPairing, 2_000);
    assert.equal(controller.selectedMode, "gif");
    assert.equal(controller.view.confirmedMode, "auto");
    assert.match(controller.view.message, /select another mode to change the display/i);
  });
});

test("selecting the already active mode does not queue a mode command", async () => {
  await withStore(async (store) => {
    const controller = new DisplayModeController(store, "auto");
    await controller.initialize();
    await controller.observeDeviceMode("gif", firstPairing, 2_000);
    await controller.selectManual("auto", firstPairing);
    assert.equal(await controller.pendingCommandFor(firstPairing), null);
    assert.equal(controller.selectedMode, "auto");
    assert.match(controller.view.message, /different mode/i);
  });
});

test("changing the paired credential clears pending mode without applying it to another device", async () => {
  await withStore(async (store) => {
    const controller = new DisplayModeController(store, "auto");
    await controller.initialize();
    await controller.selectManual("gif", firstPairing);
    assert.equal(await controller.pendingCommandFor(secondPairing), null);
    assert.equal(controller.view.syncState, "failed");
    assert.equal(controller.view.pendingMode, null);

    const restarted = new DisplayModeController(store, "auto");
    await restarted.initialize();
    assert.equal(await restarted.pendingCommandFor(secondPairing), null);
    assert.equal(restarted.view.mode, "gif");
  });
});

test("failed persistence does not acknowledge a mode selection", async () => {
  const store = new FileDisplayModeStore("/dev/null/neonbyte-mode/display-mode.json");
  const controller = new DisplayModeController(store, "auto");
  await controller.initialize();
  await assert.rejects(controller.selectManual("gif", "paired-device"));
  assert.equal(controller.selectedMode, "auto");
  assert.equal(controller.view.syncState, "failed");
});

test("device target identifiers are stable hashes and do not expose the pairing credential", () => {
  const target = modeTargetId("private-pairing-token");
  assert.match(target, /^[0-9a-f]{64}$/);
  assert.equal(target, modeTargetId("private-pairing-token"));
  assert.notEqual(target, modeTargetId("replacement-pairing-token"));
  assert.equal(target.includes("private-pairing-token"), false);
});
