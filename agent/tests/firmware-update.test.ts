import assert from "node:assert/strict";
import test from "node:test";
import { FirmwareUpdateService, SystemFirmwareUpdateJournal, type FirmwareUpdateJournal, type FirmwareUpdateRecord } from "../src/device/firmware-update.js";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { broadenWindowsAcl, restrictWindowsAcl } from "./windows-acl.js";
import type { PreparedFirmwareCandidate } from "../src/device/firmware-inbox.js";
import type { MaintenanceDiagnostics, MaintenanceInfo, MaintenanceStatus } from "../src/device/maintenance-client.js";
import type { RecoveryCredential, RecoveryCredentialStore } from "../src/device/recovery-store.js";

const credential: RecoveryCredential = { version: 1, token: "a".repeat(64), deviceId: "esp8266-a1b2c3",
  profile: "esp8266-dio40-4mb", recoveryIdentityFingerprint: "b".repeat(64), lastVerifiedAddress: "http://192.168.1.20" };
const manifest = { buildId: "build-new", deviceId: credential.deviceId, profile: credential.profile,
  recoveryIdentityFingerprint: credential.recoveryIdentityFingerprint,
  target: { family: "esp8266", flashMode: "dio", flashFrequencyMHz: 40, flashBytes: 4_194_304 },
  sourceRevision: "1".repeat(40),
  linkedRegions: { bootloaderStart: 0, applicationStart: 4096, filesystemStart: 1_048_576, filesystemEnd: 4_169_728, eepromStart: 4_173_824 },
  featureGates: { maintenanceOnBoot: true, otaEnabled: true }, minimumResources: { minimumFreeHeapBytes: 1000, minimumLargestBlockBytes: 500 },
  validation: { combinedImage: true, modernCrc: true, runtimeBounds: true, recoveryIdentity: true } } as PreparedFirmwareCandidate["manifest"];
const candidate: PreparedFirmwareCandidate = { id: "candidate-1", fileName: "firmware.bin", byteLength: 4096,
  sha256: "c".repeat(64), bytes: Buffer.from("firmware"), manifest };

class MemoryJournal implements FirmwareUpdateJournal {
  value: FirmwareUpdateRecord | null = null;
  async load() { return this.value; }
  async save(value: FirmwareUpdateRecord) { this.value = structuredClone(value); }
}

function fixture(options: { lostPut?: boolean; bootId?: string; buildId?: string; candidateTtlMs?: number; bootSequence?: string[]; automaticStartup?: boolean; experimental?: boolean; geometryPending?: boolean; experimentalFloors?: boolean;
  offlineAfterPut?: boolean; reconnectWindowMs?: number; initiallyPaused?: boolean; recoveryApLostAfterDrain?: boolean; candidateBuildId?: string } = {}) {
  const journal = new MemoryJournal();
  const calls: string[] = [];
  const info = (bootId: string, buildId: string): MaintenanceInfo => ({ deviceId: credential.deviceId, bootId, buildId,
    firmwareVersion: "0.2.0", stationIp: "192.168.1.20", recoveryApIp: "192.168.4.1", otaEnabled: true,
    maxFirmwareBytes: 458752, profile: credential.profile, recoveryIdentityFingerprint: credential.recoveryIdentityFingerprint });
  let currentInfo = info(options.bootId ?? "boot-before", "build-old");
  let infoCalls = 0;
  let running = !options.initiallyPaused;
  let recoveryApRunning = true;
  let uploadCompleted = false;
  let tick = 0;
  let statusOverrides: Partial<MaintenanceStatus> = {};
  const timeoutBudgets: number[] = [];
  const status = (): MaintenanceStatus => ({ storageAvailable: true, configurationLoaded: true, applicationRunning: running,
    recoveryApRunning, stationConnected: true, pendingWifi: false, volatileWifi: false, ...statusOverrides });
  const diagnostics: MaintenanceDiagnostics = { freeHeapBytes: 10_000, maxFreeBlockBytes: 5_000, resetReason: 0,
    connectionsAccepted: 1, connectionsDisconnected: 0, idleTimeouts: 0, totalTimeouts: 0, uploadsStarted: 0,
    uploadsAborted: 0, uploadsCompleted: 0, uploadFailures: 0, uploadBytes: 0, maxLoopGapMs: 10 };
  const client = {
    info: async (timeoutMs?: number) => {
      calls.push("info"); infoCalls++;
      if (uploadCompleted && options.offlineAfterPut) {
        const budget = timeoutMs ?? 10_000;
        timeoutBudgets.push(budget);
        tick += budget;
        throw new Error("offline");
      }
      if (options.bootSequence && infoCalls >= 4) currentInfo = info(options.bootSequence[Math.min(infoCalls - 4, options.bootSequence.length - 1)]!, "build-new");
      return currentInfo;
    },
    status: async () => { calls.push("status"); return status(); },
    diagnostics: async () => { calls.push("diagnostics"); return diagnostics; },
    pause: async () => { calls.push("pause"); running = false; },
    run: async () => { calls.push("run"); running = true; },
    uploadFirmware: async () => { calls.push("put"); if (options.lostPut) throw new Error("lost"); currentInfo = info("boot-after", options.buildId ?? "build-new"); uploadCompleted = true; },
  };
  const recoveryStore: RecoveryCredentialStore = { get: async () => credential, set: async () => {}, delete: async () => {} };
  let suspended = false;
  let heldForMaintenance = false;
  let resumed = false;
  let preflightAbortResumed = false;
  const service = new FirmwareUpdateService({
    recoveryStore, inbox: { prepare: async () => ({ ...candidate, manifest: { ...manifest,
      ...(options.experimental ? { purpose: "experimental-test", minimumResources: options.experimentalFloors ? manifest.minimumResources : null } : {}),
      ...(options.geometryPending ? { validation: { ...manifest.validation, runtimeBounds: { state: "device-check-pending", requiredBuildId: "build-old" } } } : {}),
      ...(options.candidateBuildId ? { buildId: options.candidateBuildId } : {}),
      ...(options.automaticStartup ? { featureGates: { maintenanceOnBoot: false, otaEnabled: true, maintenanceAfterSoftwareRestart: true } } : {}) } }) }, journal,
    createClient: () => client,
    device: { suspendAndDrain: async () => { calls.push("suspend"); suspended = true;
        if (options.recoveryApLostAfterDrain) recoveryApRunning = false;
      },
      holdForMaintenance: () => { heldForMaintenance = true; },
      resumeAfterSafePreflightAbort: () => { preflightAbortResumed = true; calls.push("resume-after-abort"); },
      resumeAfterExplicitRun: () => { resumed = true; }, resumeAfterManualReconciliation: () => { resumed = true; } },
    now: () => tick, wait: async (milliseconds) => { tick += milliseconds; },
    ...(options.reconnectWindowMs !== undefined ? { reconnectWindowMs: options.reconnectWindowMs } : {}),
    ...(options.candidateTtlMs !== undefined ? { candidateTtlMs: options.candidateTtlMs } : {}),
  });
  return { service, journal, calls, client, setInfo: (value: MaintenanceInfo) => { currentInfo = value; }, advance: (ms: number) => { tick += ms; },
    setRunning: (value: boolean) => { running = value; }, setStatus: (value: Partial<MaintenanceStatus>) => { statusOverrides = value; },
    diagnostics, timeoutBudgets, get elapsedMs() { return tick; },
    get suspended() { return suspended; }, get heldForMaintenance() { return heldForMaintenance; }, get resumed() { return resumed; },
    get preflightAbortResumed() { return preflightAbortResumed; } };
}

test("one explicit candidate confirmation pauses, journals before one upload, verifies twice, and only explicit run resumes", async () => {
  const f = fixture();
  await f.service.prepare();
  assert.equal(f.service.view.state, "ready");
  await f.service.confirm("candidate-1");
  assert.equal(f.service.view.state, "waitingForReboot");
  assert.equal(f.journal.value?.putAttempted, true);
  assert.ok(f.calls.indexOf("suspend") < f.calls.indexOf("pause"));
  assert.ok(f.calls.indexOf("pause") < f.calls.indexOf("put"));
  assert.equal(f.calls.filter((call) => call === "put").length, 1);
  await assert.rejects(f.service.confirm("candidate-1"), /Prepare firmware again/);
  assert.equal(f.calls.filter((call) => call === "put").length, 1);
  assert.equal(f.suspended, true);
  await f.service.verify();
  assert.equal(f.service.view.state, "verified");
  assert.equal(f.calls.filter((call) => call === "info").length >= 4, true);
  assert.equal(f.resumed, false);
  await f.service.runApplication();
  assert.equal(f.calls.filter((call) => call === "put").length, 1);
  assert.equal(f.resumed, true);
  assert.ok(f.calls.includes("run"));
});

test("an already paused application can be updated without a pause or startup request", async () => {
  const f = fixture({ initiallyPaused: true });
  await f.service.prepare();
  await f.service.confirm("candidate-1");
  assert.equal(f.service.view.state, "waitingForReboot");
  assert.equal(f.calls.filter((call) => call === "pause").length, 0);
  assert.equal(f.calls.filter((call) => call === "put").length, 1);
  assert.equal(f.calls.includes("run"), false);
  await f.service.verify();
  assert.equal(f.service.view.state, "verified");
  assert.equal(f.resumed, false);
});

test("experimental OTA requires separate confirmation and is never reported as production verified", async () => {
  const f = fixture({ experimental: true });
  await f.service.prepare();
  assert.equal(f.service.view.candidate?.purpose, "experimental-test");
  assert.equal(f.service.view.candidate?.sourceRevision, "1".repeat(40));
  await assert.rejects(f.service.confirm("candidate-1"), /explicit experimental authorization/i);
  assert.equal(f.calls.includes("put"), false);
  assert.equal(f.calls.includes("pause"), false);

  await f.service.confirm("candidate-1", true);
  assert.equal(f.calls.filter((call) => call === "put").length, 1);
  await f.service.verify();
  assert.equal(f.service.view.state, "experimentallyVerified");
  assert.match(f.service.view.message, /production.*pending/i);
  assert.equal(f.journal.value?.minimumFreeHeapBytes, null);
  assert.equal(f.journal.value?.minimumLargestBlockBytes, null);
  assert.equal(f.resumed, false);
  await f.service.runApplication();
  assert.equal(f.resumed, true);
  assert.equal(f.calls.includes("run"), true);
  assert.match(f.service.view.message, /experimental.*production/i);
});

test("deferred geometry requires its own acknowledgement and remains pending in the journal", async () => {
  const f = fixture({ experimental: true, geometryPending: true, experimentalFloors: true });
  await f.service.prepare();
  assert.deepEqual(f.service.view.candidate?.runtimeBounds, { state: "device-check-pending", requiredBuildId: "build-old" });
  assert.deepEqual(f.journal.value?.runtimeBounds, { state: "device-check-pending", requiredBuildId: "build-old" });
  await assert.rejects(f.service.confirm("candidate-1", true), /geometry.*confirmation/i);
  assert.equal(f.calls.includes("pause"), false);
  assert.equal(f.calls.includes("put"), false);
  await f.service.confirm("candidate-1", true, true);
  assert.equal(f.calls.filter((call) => call === "put").length, 1);
  await f.service.verify();
  assert.equal(f.service.view.state, "experimentallyVerified");
  assert.deepEqual(f.journal.value?.runtimeBounds, { state: "device-check-pending", requiredBuildId: "build-old" });
  assert.equal(f.journal.value?.minimumFreeHeapBytes, 1000);
  assert.equal(f.journal.value?.minimumLargestBlockBytes, 500);
});

test("experimental candidates with explicit resource floors reject low memory before pausing", async () => {
  const f = fixture({ experimental: true, geometryPending: true, experimentalFloors: true });
  f.diagnostics.maxFreeBlockBytes = 499;
  await f.service.prepare();
  await assert.rejects(f.service.confirm("candidate-1", true, true), /memory requirement/i);
  assert.equal(f.calls.includes("pause"), false);
  assert.equal(f.calls.includes("put"), false);
});

test("production cannot use deferred geometry even if an inbox returns it", async () => {
  const f = fixture({ geometryPending: true });
  await assert.rejects(f.service.prepare(), /preparation failed/i);
  assert.equal(f.calls.includes("pause"), false);
  assert.equal(f.calls.includes("put"), false);
});

test("deferred geometry rejects an installed build other than the reviewed build", async () => {
  const f = fixture({ experimental: true, geometryPending: true, experimentalFloors: true });
  f.setInfo({ deviceId: credential.deviceId, bootId: "boot-before", buildId: "unreviewed-build", firmwareVersion: "0.2.0",
    stationIp: "192.168.1.20", recoveryApIp: "192.168.4.1", otaEnabled: true, maxFirmwareBytes: 458752,
    profile: credential.profile, recoveryIdentityFingerprint: credential.recoveryIdentityFingerprint });
  await assert.rejects(f.service.prepare(), /reviewed installed build/i);
  assert.equal(f.calls.includes("pause"), false);
  assert.equal(f.calls.includes("put"), false);
});

test("protected journal retains deferred geometry and rejects production or partial floors", async (t) => {
  const f = fixture({ experimental: true, geometryPending: true, experimentalFloors: true });
  await f.service.prepare();
  const directory = await mkdtemp(join(tmpdir(), "neonbyte-deferred-journal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  restrictWindowsAcl(directory);
  const journal = new SystemFirmwareUpdateJournal(join(directory, "NeonByte", "firmware-update.json"));
  const record = f.journal.value!;
  await journal.save(record);
  assert.deepEqual((await journal.load())?.runtimeBounds, { state: "device-check-pending", requiredBuildId: "build-old" });
  await assert.rejects(journal.save({ ...record, purpose: "production" }), /invalid/i);
  await assert.rejects(journal.save({ ...record, minimumLargestBlockBytes: null }), /invalid/i);
  assert.deepEqual((await journal.load())?.runtimeBounds, { state: "device-check-pending", requiredBuildId: "build-old" });
});

test("experimental post-boot observations still require healthy recovery network and loaded storage", async () => {
  for (const unsafeStatus of [
    { stationConnected: false },
    { recoveryApRunning: false },
    { configurationLoaded: false },
    { storageAvailable: false },
    { pendingWifi: true },
    { volatileWifi: true },
  ]) {
    const f = fixture({ experimental: true, reconnectWindowMs: 5_000 });
    await f.service.prepare();
    await f.service.confirm("candidate-1", true);
    f.setStatus(unsafeStatus);
    await f.service.verify();
    assert.equal(f.service.view.state, "verificationFailed");
    assert.notEqual(f.service.view.state, "experimentallyVerified");
    assert.equal(f.resumed, false);
    assert.equal(f.calls.includes("run"), false);
  }
});

test("an automatically running post-update app is not verified and cannot release synchronization", async () => {
  const f = fixture({ reconnectWindowMs: 5000, automaticStartup: true });
  await f.service.prepare(); await f.service.confirm("candidate-1");
  f.setRunning(true);
  assert.equal(f.calls.filter((call) => call === "put").length, 1);
  f.calls.length = 0;
  await f.service.verify();
  assert.equal(f.service.view.state, "verificationFailed");
  assert.equal(f.calls.filter((call) => call === "status").length, 1);
  assert.match(f.service.view.message, /running.*reconciliation/i);
  assert.equal(f.resumed, false);
  assert.equal(f.calls.filter((call) => call === "put").length, 0);
  assert.equal(f.calls.includes("run"), false);
});

async function runningAttempt(state: FirmwareUpdateRecord["state"] = "verificationFailed") {
  const original = fixture();
  await original.service.prepare();
  const record = { ...original.journal.value!, state, putAttempted: true };
  const recovered = fixture({ reconnectWindowMs: 5000, candidateBuildId: "build-next" });
  recovered.journal.value = record;
  recovered.setInfo({ deviceId: credential.deviceId, bootId: "boot-after", buildId: "build-new", firmwareVersion: "0.2.0",
    stationIp: "192.168.1.20", recoveryApIp: "192.168.4.1", otaEnabled: true, maxFirmwareBytes: 458752,
    profile: credential.profile, recoveryIdentityFingerprint: credential.recoveryIdentityFingerprint });
  recovered.setRunning(true);
  await recovered.service.restore();
  return Object.assign(recovered, { originalRecord: record });
}

test("explicit recovery acknowledges two authenticated running observations without marking the OTA verified", async () => {
  const f = await runningAttempt();
  assert.equal(f.journal.value?.state, "verificationFailed");
  assert.equal(f.service.view.state, "verificationFailed");
  await assert.rejects(f.service.prepare(), /previous firmware/i);
  await f.service.verify();
  assert.equal(f.service.view.state, "verificationFailed");
  f.calls.length = 0;
  const recovered = await f.service.reconcileRunning("build-new", true);
  assert.equal(recovered.state, "manuallyReconciled");
  assert.equal(f.journal.value?.manualReconciliation?.bootId, "boot-after");
  assert.equal(f.journal.value?.manualReconciliation?.observations, 2);
  assert.ok((f.journal.value?.manualReconciliation?.intervalMs ?? 0) >= 2000);
  assert.equal(f.calls.filter((call) => call === "info").length, 4);
  assert.equal(f.calls.filter((call) => call === "status").length, 2);
  assert.equal(f.calls.filter((call) => call === "diagnostics").length, 2);
  assert.ok(f.journal.value?.history?.some((entry) => entry.state === "verificationFailed"));
  assert.equal(f.resumed, true);
  assert.equal(f.calls.includes("put"), false);
  assert.equal(f.calls.includes("pause"), false);
  assert.equal(f.calls.includes("run"), false);
  const recoveredJournal = structuredClone(f.journal.value);
  const restarted = fixture({ candidateBuildId: "build-next" });
  restarted.journal.value = recoveredJournal;
  restarted.setInfo(await f.client.info());
  await restarted.service.restore();
  assert.equal(restarted.service.view.state, "manuallyReconciled");
  await restarted.service.prepare();
  assert.ok(restarted.journal.value?.history?.some((entry) => entry.state === "verificationFailed"));
  assert.ok(restarted.journal.value?.history?.some((entry) => entry.state === "manuallyReconciled"));
  assert.equal(restarted.calls.includes("put"), false);
});

test("manual recovery rejects missing confirmation, wrong identity, unstable boot and unhealthy diagnostics", async () => {
  const unconfirmed = await runningAttempt();
  await assert.rejects(unconfirmed.service.reconcileRunning("build-new", false), /confirm/i);
  await assert.rejects(unconfirmed.service.reconcileRunning("wrong-build", true), /confirm/i);
  assert.equal(unconfirmed.calls.includes("info"), false);
  for (const failure of ["build", "identity", "device", "boot", "heap", "block", "network", "recovery", "wifi", "paused", "ota", "capacity", "unstable"] as const) {
    const f = await runningAttempt();
    const current = await f.client.info();
    if (failure === "build") f.setInfo({ ...current, buildId: "build-wrong" });
    if (failure === "identity") f.setInfo({ ...current, recoveryIdentityFingerprint: "d".repeat(64) });
    if (failure === "device") f.setInfo({ ...current, deviceId: "esp8266-wrong" });
    if (failure === "boot") f.setInfo({ ...current, bootId: "boot-before" });
    if (failure === "heap") f.diagnostics.freeHeapBytes = 999;
    if (failure === "block") f.diagnostics.maxFreeBlockBytes = 499;
    if (failure === "network") f.setStatus({ stationConnected: false });
    if (failure === "recovery") f.setStatus({ recoveryApRunning: false });
    if (failure === "wifi") f.setStatus({ pendingWifi: true });
    if (failure === "paused") f.setRunning(false);
    if (failure === "ota") f.setInfo({ ...current, otaEnabled: false });
    if (failure === "capacity") f.setInfo({ ...current, maxFirmwareBytes: 100 });
    if (failure === "unstable") {
      let calls = 0;
      f.client.info = async () => ({ ...current, bootId: ++calls > 2 ? "boot-other" : "boot-after" });
    }
    await assert.rejects(f.service.reconcileRunning("build-new", true), /reconcil|identity|health|boot|device/i, failure);
    assert.equal(f.resumed, false, failure);
    assert.equal(f.calls.includes("put"), false, failure);
    assert.notEqual(f.journal.value?.state, "manuallyReconciled", failure);
  }
  const failedTransfer = await runningAttempt("transferFailed");
  await assert.rejects(failedTransfer.service.reconcileRunning("build-new", true), /failed|rejected/i);
  await assert.rejects(failedTransfer.service.verify(), /failed|rejected/i);
  assert.equal(failedTransfer.journal.value?.state, "transferFailed");
  assert.equal(failedTransfer.resumed, false);
});

test("manual recovery never drops protected journal history or retries an unreachable device", async () => {
  const full = await runningAttempt();
  full.journal.value = { ...full.journal.value!, history: Array.from({ length: 8 }, () => ({ ...full.originalRecord })) };
  const reloaded = fixture();
  reloaded.journal.value = full.journal.value;
  reloaded.setInfo(await full.client.info());
  await reloaded.service.restore();
  await assert.rejects(reloaded.service.reconcileRunning("build-new", true), /history is full/i);
  assert.equal(reloaded.journal.value?.history?.length, 8);
  assert.equal(reloaded.resumed, false);

  const offline = await runningAttempt();
  let calls = 0;
  offline.client.info = async (timeoutMs?: number) => {
    calls++;
    offline.advance(timeoutMs ?? 0);
    throw new Error("offline");
  };
  await assert.rejects(offline.service.reconcileRunning("build-new", true));
  assert.equal(calls, 1);
  assert.equal(offline.resumed, false);
});

test("protected journal retains reconciliation evidence and the previous attempt after another preparation", async (t) => {
  const f = await runningAttempt();
  await f.service.reconcileRunning("build-new", true);
  const manualRecord = structuredClone(f.journal.value!);
  await f.service.prepare();
  const directory = await mkdtemp(join(tmpdir(), "neonbyte-reconciliation-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  restrictWindowsAcl(directory);
  const journal = new SystemFirmwareUpdateJournal(join(directory, "NeonByte", "firmware-update.json"));
  await journal.save(f.journal.value!);
  const restored = await journal.load();
  assert.ok(restored?.history?.some((entry) => entry.state === "verificationFailed"));
  const recovered = restored?.history?.find((entry) => entry.state === "manuallyReconciled");
  assert.equal(recovered?.manualReconciliation?.bootId, "boot-after");
  assert.equal(recovered?.manualReconciliation?.observations, 2);
  const invalid = structuredClone(restored!);
  const invalidRecovery = invalid.history!.find((entry) => entry.state === "manuallyReconciled")!;
  invalidRecovery.manualReconciliation!.bootId = invalidRecovery.expectedBootId;
  await assert.rejects(journal.save(invalid), /invalid/);
  await assert.rejects(journal.save({ ...manualRecord, history: [] }), /invalid/);
  const mismatchedHistory = structuredClone(manualRecord);
  mismatchedHistory.history![mismatchedHistory.history!.length - 1]!.recoveryIdentityFingerprint = "d".repeat(64);
  await assert.rejects(journal.save(mismatchedHistory), /invalid/);
  assert.deepEqual(await journal.load(), restored);
  const serialized = await readFile(join(directory, "NeonByte", "firmware-update.json"), "utf8");
  assert.equal(serialized.includes(credential.token), false);
});

test("manual recovery keeps the scheduler held if the protected journal cannot be saved", async () => {
  const f = await runningAttempt();
  f.journal.save = async () => { throw new Error("disk unavailable"); };
  await assert.rejects(f.service.reconcileRunning("build-new", true));
  assert.equal(f.resumed, false);
  assert.notEqual(f.service.view.state, "manuallyReconciled");
  assert.equal(f.journal.value?.state, "verificationFailed");
});

test("a changed boot after manual reconciliation blocks preparation and preserves the recovery history", async () => {
  const f = await runningAttempt();
  await f.service.reconcileRunning("build-new", true);
  const observed = await f.client.info();
  f.setInfo({ ...observed, bootId: "boot-changed" });
  await assert.rejects(f.service.prepare(), /reconcile.*again/i);
  assert.equal(f.journal.value?.state, "verificationFailed");
  assert.ok(f.journal.value?.history?.some((entry) => entry.state === "manuallyReconciled"));
  assert.equal(f.service.view.recoverableAttempt?.expectedBuildId, "build-new");
  assert.equal(f.calls.includes("put"), false);
});

test("a changed recovery identity after reconciliation re-locks the journal before another preparation", async () => {
  const f = await runningAttempt();
  await f.service.reconcileRunning("build-new", true);
  const observed = await f.client.info();
  f.setInfo({ ...observed, recoveryIdentityFingerprint: "d".repeat(64) });
  await assert.rejects(f.service.prepare(), /reconcile.*again/i);
  assert.equal(f.journal.value?.state, "verificationFailed");
  assert.ok(f.journal.value?.history?.some((entry) => entry.state === "manuallyReconciled"));
  assert.equal(f.calls.includes("put"), false);
});

test("a legacy running image can transition to an automatic-start candidate through paused verification and explicit run", async () => {
  const f = fixture({ automaticStartup: true });
  await f.service.prepare(); await f.service.confirm("candidate-1");
  assert.equal(f.service.view.state, "waitingForReboot");
  assert.equal(f.resumed, false);
  await f.service.verify();
  assert.equal(f.service.view.state, "verified");
  assert.equal(f.calls.includes("run"), false);
  await f.service.runApplication();
  assert.equal(f.service.view.state, "started");
  assert.equal(f.calls.filter((call) => call === "put").length, 1);
  assert.equal(f.resumed, true);
});

test("explicit run must be observed running before recording started and resuming synchronization", async () => {
  const f = fixture();
  await f.service.prepare(); await f.service.confirm("candidate-1"); await f.service.verify();
  f.client.run = async () => { f.calls.push("run"); };
  await assert.rejects(f.service.runApplication(), /did not start/);
  assert.equal(f.service.view.state, "verified");
  assert.equal(f.journal.value?.state, "verified");
  assert.equal(f.resumed, false);
});

test("a power cycle after verification requires fresh verification before accepting an automatically running app", async () => {
  const f = fixture({ automaticStartup: true });
  await f.service.prepare(); await f.service.confirm("candidate-1"); await f.service.verify();
  const verifiedInfo = await f.client.info();
  f.setInfo({ ...verifiedInfo, bootId: "power-cycled-after-verification" });
  f.setRunning(true);
  await assert.rejects(f.service.runApplication(), /identity changed|verify again/);
  assert.equal(f.resumed, false);
  assert.equal(f.calls.includes("run"), false);
  assert.equal(f.service.view.state, "verificationFailed");
});

test("maintenance network state is rechecked after the scheduler drains and before pause or upload", async () => {
  const f = fixture({ recoveryApLostAfterDrain: true });
  await f.service.prepare();
  await assert.rejects(f.service.confirm("candidate-1"), /stable maintenance-ready state/);
  assert.equal(f.calls.includes("pause"), false);
  assert.equal(f.calls.includes("put"), false);
  assert.equal(f.preflightAbortResumed, true);
  assert.equal(f.resumed, false);
});

test("a safe preflight abort leaves an already paused application and scheduler held", async () => {
  const f = fixture({ initiallyPaused: true, recoveryApLostAfterDrain: true });
  await f.service.prepare();
  await assert.rejects(f.service.confirm("candidate-1"), /stable maintenance-ready state/);
  assert.equal(f.calls.includes("pause"), false);
  assert.equal(f.calls.includes("put"), false);
  assert.equal(f.preflightAbortResumed, false);
  assert.equal(f.resumed, false);
});

test("lost firmware response becomes outcomeUnknown and verification never repeats the PUT", async () => {
  const f = fixture({ lostPut: true });
  await f.service.prepare();
  await f.service.confirm("candidate-1");
  assert.equal(f.service.view.state, "outcomeUnknown");
  await f.service.verify();
  assert.equal(f.calls.filter((call) => call === "put").length, 1);
  assert.equal(f.calls.includes("run"), false);
  assert.equal(f.resumed, false);
  assert.equal(f.service.view.state, "verificationFailed");
});

test("a wrong running build cannot be marked verified or resumed", async () => {
  const f = fixture({ buildId: "build-wrong" });
  await f.service.prepare();
  await f.service.confirm("candidate-1");
  await f.service.verify();
  assert.equal(f.service.view.state, "verificationFailed");
  await assert.rejects(f.service.runApplication(), /verified firmware/);
  assert.equal(f.resumed, false);
});

test("an unreachable device remains outcomeUnknown and reads stay inside the verification window", async () => {
  const f = fixture({ offlineAfterPut: true, reconnectWindowMs: 1000 });
  await f.service.prepare();
  await f.service.confirm("candidate-1");
  await f.service.verify();
  assert.equal(f.service.view.state, "outcomeUnknown");
  assert.deepEqual(f.timeoutBudgets, [1000]);
  assert.equal(f.elapsedMs, 1000);
});

test("two boot observations must identify the same post-update boot instance", async () => {
  const f = fixture({ bootSequence: ["boot-after-1", "boot-after-2", "boot-after-2"] });
  await f.service.prepare();
  await f.service.confirm("candidate-1");
  await f.service.verify();
  assert.equal(f.service.view.state, "verified");
  assert.ok(f.calls.filter((call) => call === "info").length >= 6);
});

test("candidate approval expires and cannot send firmware", async () => {
  const f = fixture({ candidateTtlMs: 1000 });
  await f.service.prepare();
  f.advance(1001);
  await assert.rejects(f.service.confirm("candidate-1"), /Prepare firmware again/);
  assert.equal(f.calls.includes("put"), false);
  assert.equal(f.service.view.candidate, null);
});

test("restart restoration invalidates a ready candidate and does not replay an attempted PUT", async () => {
  const f = fixture();
  await f.service.prepare();
  const readyRecord = f.journal.value;
  assert.equal(readyRecord?.putAttempted, false);
  const restarted = fixture();
  restarted.journal.value = { ...readyRecord!, state: "ready", putAttempted: false };
  await restarted.service.restore();
  assert.equal(restarted.service.view.state, "idle");

  const attempted = fixture();
  attempted.journal.value = { ...readyRecord!, state: "uploading", putAttempted: true };
  await attempted.service.restore();
  assert.equal(attempted.service.view.state, "outcomeUnknown");
  assert.equal(attempted.heldForMaintenance, true);
  assert.equal(attempted.calls.includes("put"), false);
  assert.equal(attempted.resumed, false);

  const legacyVerified = fixture();
  legacyVerified.journal.value = { ...readyRecord!, state: "verified", putAttempted: true };
  await legacyVerified.service.restore();
  assert.equal(legacyVerified.service.view.state, "outcomeUnknown");
  assert.equal(legacyVerified.heldForMaintenance, true);
  assert.equal(legacyVerified.calls.includes("put"), false);
});

test("restarted OTA intent verifies the new paused build without replay and waits for explicit run", async () => {
  const prepared = fixture();
  await prepared.service.prepare();
  const record = { ...prepared.journal.value!, state: "waitingForReboot" as const, putAttempted: true };
  const restarted = fixture();
  restarted.journal.value = record;
  restarted.setInfo({ deviceId: credential.deviceId, bootId: "boot-after", buildId: "build-new", firmwareVersion: "0.2.0",
    stationIp: "192.168.1.20", recoveryApIp: "192.168.4.1", otaEnabled: true, maxFirmwareBytes: 458752,
    profile: credential.profile, recoveryIdentityFingerprint: credential.recoveryIdentityFingerprint });
  restarted.setRunning(false);
  await restarted.service.restore();
  assert.equal(restarted.service.view.state, "outcomeUnknown");
  assert.equal(restarted.heldForMaintenance, true);
  await restarted.service.verify();
  assert.equal(restarted.service.view.state, "verified");
  assert.equal(restarted.calls.filter((call) => call === "put").length, 0);
  assert.equal(restarted.calls.includes("run"), false);
  assert.equal(restarted.resumed, false);
  await restarted.service.runApplication();
  assert.equal(restarted.calls.filter((call) => call === "put").length, 0);
  assert.equal(restarted.calls.filter((call) => call === "run").length, 1);
  assert.equal(restarted.resumed, true);
});

test("persistent journal is private and contains only non-secret update intent", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "neonbyte-journal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = new SystemFirmwareUpdateJournal(join(directory, "NeonByte", "firmware-update.json"));
  restrictWindowsAcl(directory);
  const f = fixture();
  await f.service.prepare();
  const record = f.journal.value!;
  await journal.save(record);
  assert.deepEqual(await journal.load(), record);
  const serialized = await readFile(join(directory, "NeonByte", "firmware-update.json"), "utf8");
  assert.equal(serialized.includes(credential.token), false);
  assert.equal(serialized.includes("firmware-inbox"), false);
  if (process.platform === "win32") {
    await broadenWindowsAcl(join(directory, "NeonByte"));
  } else {
    assert.equal((await stat(join(directory, "NeonByte"))).mode & 0o077, 0);
    assert.equal((await stat(join(directory, "NeonByte", "firmware-update.json"))).mode & 0o077, 0);
    await chmod(join(directory, "NeonByte"), 0o755);
  }
  await assert.rejects(journal.load(), /unsafe permissions/);
});
