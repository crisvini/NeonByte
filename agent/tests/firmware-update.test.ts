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
const manifest = { buildId: "build-new", target: { family: "esp8266", flashMode: "dio", flashFrequencyMHz: 40, flashBytes: 4_194_304 },
  featureGates: { maintenanceOnBoot: true, otaEnabled: true }, minimumResources: { minimumFreeHeapBytes: 1000, minimumLargestBlockBytes: 500 } } as PreparedFirmwareCandidate["manifest"];
const candidate: PreparedFirmwareCandidate = { id: "candidate-1", fileName: "firmware.bin", byteLength: 4096,
  sha256: "c".repeat(64), bytes: Buffer.from("firmware"), manifest };

class MemoryJournal implements FirmwareUpdateJournal {
  value: FirmwareUpdateRecord | null = null;
  async load() { return this.value; }
  async save(value: FirmwareUpdateRecord) { this.value = structuredClone(value); }
}

function fixture(options: { lostPut?: boolean; bootId?: string; buildId?: string; candidateTtlMs?: number; bootSequence?: string[];
  offlineAfterPut?: boolean; reconnectWindowMs?: number; initiallyPaused?: boolean; recoveryApLostAfterDrain?: boolean } = {}) {
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
  const timeoutBudgets: number[] = [];
  const status = (): MaintenanceStatus => ({ storageAvailable: true, configurationLoaded: true, applicationRunning: running,
    recoveryApRunning, stationConnected: true, pendingWifi: false, volatileWifi: false });
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
    recoveryStore, inbox: { prepare: async () => candidate }, journal,
    createClient: () => client,
    device: { suspendAndDrain: async () => { calls.push("suspend"); suspended = true;
        if (options.recoveryApLostAfterDrain) recoveryApRunning = false;
      },
      holdForMaintenance: () => { heldForMaintenance = true; },
      resumeAfterSafePreflightAbort: () => { preflightAbortResumed = true; calls.push("resume-after-abort"); },
      resumeAfterExplicitRun: () => { resumed = true; } },
    now: () => tick, wait: async (milliseconds) => { tick += milliseconds; },
    ...(options.reconnectWindowMs !== undefined ? { reconnectWindowMs: options.reconnectWindowMs } : {}),
    ...(options.candidateTtlMs !== undefined ? { candidateTtlMs: options.candidateTtlMs } : {}),
  });
  return { service, journal, calls, client, setInfo: (value: MaintenanceInfo) => { currentInfo = value; }, advance: (ms: number) => { tick += ms; },
    setRunning: (value: boolean) => { running = value; }, timeoutBudgets, get elapsedMs() { return tick; },
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
