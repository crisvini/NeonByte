import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sourcePromise = readFile(new URL("../src/web/public/app.js", import.meta.url), "utf8");

function element() {
  return { textContent: "", value: "", hidden: false, disabled: false,
    classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {},
    querySelector: () => ({ textContent: "" }) };
}

test("device settings accept the IPv4 address shown on the device", async () => {
  const source = await sourcePromise;
  const start = source.indexOf('document.querySelector("#device-form").addEventListener');
  const end = source.indexOf("\nasync function runOtaAction", start);
  let submit!: (event: { preventDefault(): void }) => Promise<void>;
  let sent: unknown;
  const sandbox = vm.createContext({
    document: { querySelector: (selector: string) => selector === "#device-form"
      ? { addEventListener: (_type: string, handler: typeof submit) => { submit = handler; } }
      : selector === "#device-address" ? { value: "192.168.68.65" } : { checked: true } },
    postJson: async (_path: string, body: unknown) => { sent = JSON.parse(JSON.stringify(body)); },
    refreshStatus: async () => {}, notify() {},
  });
  vm.runInContext(source.slice(start, end), sandbox);
  await submit({ preventDefault() {} });
  assert.deepEqual(sent, { address: "http://192.168.68.65", enabled: true });
});

test("reloading a dashboard never posts a mode from stale browser storage", async () => {
  const source = await sourcePromise;
  const start = source.indexOf("async function initialize()");
  const end = source.indexOf("\nvoid initialize();", start);
  const modePosts: Array<{ path: string; body: unknown }> = [];
  const sandbox = vm.createContext({
    mode: "auto", localStorage: { getItem: () => "gif", setItem() {} },
    request: async () => ({ json: async () => ({ mode: "auto" }) }),
    postJson: async (path: string, body: unknown) => { modePosts.push({ path, body }); },
    setModeButtons() {}, refreshStatus: async () => {}, notify() {},
    document: { querySelector: () => ({ classList: { add() {} }, textContent: "" }) },
  });
  vm.runInContext(source.slice(start, end), sandbox);
  await vm.runInContext("initialize()", sandbox) as Promise<void>;
  assert.deepEqual(modePosts, []);
});

test("a rejected manual mode selection keeps the last accepted mode", async () => {
  const source = await sourcePromise;
  const start = source.indexOf("async function chooseMode(");
  const end = source.indexOf("function updateLamp", start);
  const posts: unknown[] = [];
  const sandbox = vm.createContext({ mode: "auto", preparedGifPreview: false, modePending: false,
    otaMutationLocked: () => false, status: null, modeHelp: { auto: "Auto", gif: "GIF" },
    document: { querySelectorAll: () => [], querySelector: () => ({ textContent: "", setAttribute() {}, disabled: false }) },
    setModeButtons() {}, postJson: async () => { throw new Error("Agent unavailable."); },
    refreshStatus: async () => {}, notify() { posts.push("notified"); } });
  vm.runInContext(source.slice(start, end), sandbox);
  await vm.runInContext('chooseMode("gif")', sandbox) as Promise<void>;
  assert.equal(vm.runInContext("mode", sandbox), "auto");
  assert.equal(vm.runInContext("modePending", sandbox), false);
  assert.equal(vm.runInContext("preparedGifPreview", sandbox), false);
  assert.deepEqual(posts, ["notified"]);
});

test("preparing a GIF leaves the selected mode and behavior preview unchanged", async () => {
  const source = await sourcePromise;
  const start = source.indexOf("async function uploadGif(");
  const end = source.indexOf("async function replaceAnimation()", start);
  const calls: string[] = [];
  const sandbox = vm.createContext({
    MAX_GIF_BYTES: 8 * 1024 * 1024, mode: "auto", preparedGifPreview: false,
    document: { querySelector: () => element() },
    request: async (path: string) => { calls.push(path); return { json: async () => ({ sizeBytes: 1234, frameCount: 2, durationMs: 300 }) }; },
    refreshStatus: async () => {}, notify() {}, formatBytes: () => "2 KB",
  });
  vm.runInContext(source.slice(start, end), sandbox);
  await vm.runInContext('uploadGif({ size: 100, name: "test.gif" })', sandbox) as Promise<void>;
  assert.equal(vm.runInContext("mode", sandbox), "auto");
  assert.equal(vm.runInContext("preparedGifPreview", sandbox), false);
  assert.deepEqual(calls, ["/api/animation"]);
});

test("changing the USD preference posts only the preference and keeps the mode selection", async () => {
  const source = await sourcePromise;
  const start = source.indexOf("async function setUsdEnabled(");
  const end = source.indexOf("function updateLamp", start);
  const posts: Array<{ path: string; body: unknown }> = [];
  const sandbox = vm.createContext({ usdPending: false, mode: "auto", status: null, otaMutationLocked: () => false,
    document: { querySelector: () => ({ checked: true, disabled: false }) },
    postJson: async (path: string, body: unknown) => { posts.push({ path, body }); },
    refreshStatus: async () => {}, setOtaMutationLock() {}, notify() {} });
  vm.runInContext(source.slice(start, end), sandbox);
  await vm.runInContext("setUsdEnabled(true)", sandbox) as Promise<void>;
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [{ path: "/api/usd", body: { enabled: true } }]);
  assert.equal(vm.runInContext("mode", sandbox), "auto");
  assert.equal(vm.runInContext("usdPending", sandbox), false);
});

test("dashboard has one dollar preference toggle with the required label", async () => {
  const [source, html] = await Promise.all([
    sourcePromise,
    readFile(new URL("../src/web/public/index.html", import.meta.url), "utf8"),
  ]);
  assert.equal((html.match(/id="usd-enabled"/g) ?? []).length, 1);
  assert.match(html, /<label[^>]*for="usd-enabled"[^>]*>[\s\S]*?<input[^>]*id="usd-enabled"[^>]*type="checkbox"[^>]*role="switch"/);
  assert.match(html, /aria-hidden="true"[^>]*>[\s\S]*?ON[\s\S]*?OFF[\s\S]*?<\/span>/);
  assert.match(html, /Mostrar cotação do dólar<\/span>\s*<\/label>/);
  assert.match(source, /querySelector\("#usd-enabled"\)/);
});
