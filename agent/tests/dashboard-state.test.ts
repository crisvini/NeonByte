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
