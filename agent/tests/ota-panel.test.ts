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
