import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("local dashboard requests time out instead of leaving an action pending", async () => {
  const source = await readFile(new URL("../src/web/public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function request(");
  const end = source.indexOf("async function postJson(", start);
  let calls = 0;
  const sandbox = vm.createContext({ AbortSignal, Error, fetch: (_path: string, options: { signal?: AbortSignal }) => {
    calls++;
    return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  } });
  vm.runInContext(source.slice(start, end), sandbox);
  const pending = vm.runInContext("request('/slow', { timeoutMs: 10 })", sandbox) as Promise<unknown>;
  const result = await Promise.race([pending.then(() => "resolved", (error: Error) => error.message),
    new Promise<string>((resolve) => setTimeout(() => resolve("request remained pending"), 100))]);
  assert.match(result, /timed out/i);
  assert.equal(calls, 1);
});

test("dashboard status polling does not overlap a slow prior request", async () => {
  const source = await readFile(new URL("../src/web/public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function refreshStatus()");
  const end = source.indexOf("async function refreshAnimation()", start);
  let calls = 0;
  let resolveRequest!: (response: unknown) => void;
  const deferred = new Promise((resolve) => { resolveRequest = resolve; });
  const sandbox = vm.createContext({ status: null, mode: "auto", statusPending: false, agentOfflineNotified: false,
    request: () => { calls++; return deferred; }, localStorage: { setItem() {} }, setModeButtons() {}, updateStatusText() {},
    refreshFirmwareStatus: async () => {}, refreshAnimation: async () => {}, loadCover() {}, notify() {},
    document: { querySelector: () => ({ classList: { add() {} }, textContent: "" }) } });
  vm.runInContext(source.slice(start, end), sandbox);
  const first = vm.runInContext("refreshStatus()", sandbox) as Promise<void>;
  const second = vm.runInContext("refreshStatus()", sandbox) as Promise<void>;
  assert.equal(calls, 1);
  resolveRequest({ json: async () => ({ mode: "auto", snapshot: { coverUrl: "" } }) });
  await Promise.all([first, second]);
});

test("OTA controls recover after a failed action without unlocking a pending update", async () => {
  const source = await readFile(new URL("../src/web/public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function updateOtaControls()");
  const end = source.indexOf("async function refreshFirmwareStatus()", start);
  const elements = new Map<string, { disabled: boolean; hidden: boolean }>();
  const element = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, { disabled: false, hidden: false });
    return elements.get(selector)!;
  };
  const sandbox = vm.createContext({ document: { querySelector: element }, otaActionPending: true,
    firmwareUpdate: { state: "verificationFailed", candidate: null, putAttempted: true,
      recoverableAttempt: { expectedBuildId: "build-new", deviceId: "device" } } });
  vm.runInContext(source.slice(start, end), sandbox);
  vm.runInContext("updateOtaControls()", sandbox);
  assert.equal(element("#ota-reconcile").disabled, true);
  vm.runInContext("otaActionPending = false; updateOtaControls()", sandbox);
  assert.equal(element("#ota-reconcile").disabled, false);
  assert.equal(element("#ota-reconcile").hidden, false);
  assert.equal(element("#ota-prepare").disabled, true);
  vm.runInContext("firmwareUpdate.state = 'manuallyReconciled'; updateOtaControls()", sandbox);
  assert.equal(element("#ota-prepare").disabled, false);
});

test("duplicate OTA clicks are suppressed and a failure remains visible", async () => {
  const source = await readFile(new URL("../src/web/public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function runOtaAction(");
  const end = source.indexOf('document.querySelector("#ota-prepare").addEventListener', start);
  let calls = 0;
  let rejectAction!: (error: Error) => void;
  const deferred = new Promise((_resolve, reject) => { rejectAction = reject; });
  const status = { textContent: "" };
  const sandbox = vm.createContext({ otaActionPending: false, otaActionError: null,
    action: () => { calls++; return deferred; }, notify() {}, updateOtaControls() {}, refreshFirmwareStatus: async () => {},
    document: { querySelectorAll: () => [{ disabled: false }], querySelector: () => status } });
  vm.runInContext(source.slice(start, end), sandbox);
  const first = vm.runInContext("runOtaAction(action)", sandbox) as Promise<boolean>;
  const second = vm.runInContext("runOtaAction(action)", sandbox) as Promise<boolean>;
  assert.equal(await second, false);
  assert.equal(calls, 1);
  rejectAction(new Error("The previous firmware must be reconciled."));
  assert.equal(await first, false);
  assert.match(status.textContent, /must be reconciled/);
  assert.equal(vm.runInContext("otaActionPending", sandbox), false);
});

test("experimental OTA confirmation states pending production gates and sends an explicit test acknowledgement", async () => {
  const source = await readFile(new URL("../src/web/public/app.js", import.meta.url), "utf8");
  const start = source.indexOf('document.querySelector("#ota-confirm").addEventListener');
  const end = source.indexOf('document.querySelector("#ota-verify").addEventListener', start);
  const button = { addEventListener: (_event: string, handler: () => Promise<void>) => { confirmCandidate = handler; } };
  let confirmCandidate = async () => {};
  const prompts: string[] = [];
  const requests: Array<{ path: string; body: unknown }> = [];
  const candidate = { id: "candidate", fileName: "firmware.bin", byteLength: 4200, sha256: "c".repeat(64),
    expectedBuildId: "build-current", sourceRevision: "1".repeat(40), purpose: "experimental-test", deviceId: "esp8266-a1b2c3", profile: "esp8266-dio40-4mb",
    runtimeBounds: { state: "device-check-pending", requiredBuildId: "build-old" },
    target: { flashMode: "dio", flashFrequencyMHz: 40, flashBytes: 4_194_304 },
    linkedRegions: { filesystemStart: 1_048_576, filesystemEnd: 4_169_728, eepromStart: 4_173_824 } };
  const sandbox = vm.createContext({ otaActionPending: false, firmwareUpdate: { candidate },
    document: { querySelector: (selector: string) => selector === "#ota-confirm" ? button : {} },
    window: { confirm: (message: string) => { prompts.push(message); return true; } },
    formatBytes: () => "4.1 KiB", postJson: async (path: string, body: unknown) => { requests.push({ path, body }); },
    runOtaAction: async (action: () => Promise<unknown>) => { await action(); } });
  vm.runInContext(source.slice(start, end), sandbox);
  await confirmCandidate();
  assert.match(prompts[0]!, /experimental/i);
  assert.match(prompts[0]!, /production.*pending/i);
  assert.match(prompts[0]!, /backup.*recovery/i);
  assert.match(prompts[0]!, /geometry.*pending.*device/i);
  assert.match(prompts[0]!, /DIO, 40 MHz.*filesystem 1048576–4169728, EEPROM 4173824/);
  assert.equal(requests[0]?.path, "/api/ota/confirm");
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0]?.body)), { candidateId: "candidate", experimentalTestConfirmed: true, deviceGeometryConfirmed: true });
});

test("dashboard retains the deferred geometry notice after the candidate is consumed", async () => {
  const source = await readFile(new URL("../src/web/public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function refreshFirmwareStatus()");
  const end = source.indexOf("function formatBytes(", start);
  const elements = new Map<string, { textContent: string; hidden: boolean; value: string; contains: () => boolean }>();
  const element = (key: string) => {
    if (!elements.has(key)) elements.set(key, { textContent: "", hidden: false, value: "", contains: () => false });
    return elements.get(key)!;
  };
  const sandbox = vm.createContext({ firmwareStatusPending: false, firmwareUpdate: null, otaActionError: null,
    request: async () => ({ json: async () => ({ state: "waitingForReboot", candidate: null, putAttempted: true,
      runtimeBounds: { state: "device-check-pending", requiredBuildId: "build-old" }, message: "Waiting for reboot.", effectiveAddress: "", totalBytes: 0 }) }),
    document: { querySelector: element, activeElement: null }, updateOtaControls() {}, setOtaMutationLock() {}, formatBytes: () => "0 KB" });
  vm.runInContext(source.slice(start, end), sandbox);
  await vm.runInContext("refreshFirmwareStatus()", sandbox);
  assert.match(element("#ota-status").textContent, /geometry.*not independently verified/i);
});
