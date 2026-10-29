import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function preview() {
  const rectangles: number[][] = [];
  const covers: number[][] = [];
  const texts: Array<{ value: string; x: number; y: number; font: string; clip: number[] | null }> = [];
  const clipStack: Array<number[] | null> = [];
  let pathClip: number[] | null = null;
  let activeClip: number[] | null = null;
  const context = {
    font: "", fillStyle: "", textAlign: "", textBaseline: "",
    fillRect: (...args: number[]) => rectangles.push(args),
    fillText(value: string, x: number, y: number) {
      texts.push({ value, x, y, font: this.font, clip: activeClip ? [...activeClip] : null });
    },
    measureText: (value: string) => ({ width: [...value].length * 8 }),
    save() { clipStack.push(activeClip ? [...activeClip] : null); },
    restore() { activeClip = clipStack.pop() ?? null; },
    beginPath() { pathClip = null; },
    rect(x: number, y: number, width: number, height: number) { pathClip = [x, y, width, height]; },
    roundRect() {}, clip() { if (pathClip) activeClip = [...pathClip]; },
    drawImage: (...args: unknown[]) => covers.push(args.slice(-4) as number[]),
  };
  const makeElement = () => ({
    textContent: "", value: "", checked: false, hidden: false,
    classes: new Map<string, boolean>(),
    classList: { toggle(_name: string, _enabled?: boolean) {} },
    addEventListener() {}, setAttribute() {}, contains: () => false,
    querySelector: () => ({ textContent: "" }), getContext: () => context,
  });
  const elements = new Map<string, ReturnType<typeof makeElement>>();
  const element = (selector: string) => {
    if (!elements.has(selector)) {
      const value = makeElement();
      value.classList.toggle = (name: string, enabled?: boolean) => { value.classes.set(name, enabled ?? true); };
      elements.set(selector, value);
    }
    return elements.get(selector)!;
  };
  const sandbox = vm.createContext({
    document: { querySelector: element, querySelectorAll: () => [] },
    window: { setInterval() {}, requestAnimationFrame() {}, location: { search: "" } },
    URLSearchParams,
    AbortSignal: { timeout: () => ({ aborted: false }) },
    localStorage: { getItem: () => null },
    fetch: () => new Promise(() => {}),
  });
  const source = await readFile(new URL("../src/web/public/app.js", import.meta.url), "utf8");
  vm.runInContext(source, sandbox);
  return { rectangles, covers, texts, element, run: (script: string) => vm.runInContext(script, sandbox) };
}

test("Spotify preview keeps one larger-font line per field and omits progress and time", async () => {
  const display = await preview();
  display.run(`status = { snapshot: { status: "playing", nowPlaying: {
    trackId: "track", title: "Title", artist: "Artist", isPlaying: true,
    durationMs: 180000, progressMs: 1000, sampledAtUnixMs: 1000
  } } }; coverImage = { naturalWidth: 240, naturalHeight: 240 }; drawSpotify(1000);`);
  assert.deepEqual(display.covers, [[32, 4, 176, 176]]);
  assert.equal(display.texts[0]?.font, "600 16px system-ui, sans-serif");
  assert.equal(display.texts[1]?.font, "16px system-ui, sans-serif");
  assert.deepEqual(display.texts.map((text) => text.value), ["Title", "Artist"]);
  assert.deepEqual(display.rectangles, [[0, 0, 240, 240]]);
  assert.deepEqual(display.texts.map(({ x, y }) => [x, y]), [[8, 190], [8, 211]]);
  const previous = display.texts.length;
  display.run("status.snapshot.nowPlaying.progressMs = 20000; drawSpotify(20000);");
  assert.equal(display.texts.length, previous);
  assert.equal(display.covers.length, 1);
});

test("dashboard retains the converted storage warning across status refreshes", async () => {
  const display = await preview();
  display.run(`status = {
    snapshot: { status: "playing" }, demoEnabled: false, activeScene: "gif",
    device: { connection: "connected", address: "", enabled: true, paired: true, animation: { state: "blocked", attempts: 0 } },
    animation: { available: true, frameCount: 20, sizeBytes: 2304051, sha256: "0".repeat(64) }
  }; updateStatusText(); updateStatusText();`);
  const label = display.element("#upload-status");
  assert.match(label.textContent, /Converted animation does not fit in device storage/);
  assert.match(label.textContent, /installed GIF is preserved/);
  assert.equal(label.classes.get("error"), true);
  display.run('status.device.animation.state = "complete"; updateStatusText();');
  assert.match(label.textContent, /Installed on device/);
  assert.equal(label.classes.get("error"), false);
});

test("Spotify preview scrolls a long title after a pause without redrawing the cover or artist", async () => {
  const display = await preview();
  display.run(`status = { snapshot: { status: "playing", nowPlaying: {
    trackId: "track", title: "T".repeat(50), artist: "Artist"
  } } }; coverImage = { naturalWidth: 240, naturalHeight: 240 }; drawSpotify(1000);`);
  display.run("drawSpotify(2499);");
  assert.equal(display.texts.length, 2);
  display.run("drawSpotify(2500);");
  assert.equal(display.texts.length, 3);
  assert.deepEqual(display.texts.slice(2).map(({ value, x, y, clip }) => ({ value, x, y, clip })), [
    { value: "T".repeat(50), x: 5, y: 190, clip: [0, 190, 240, 20] },
  ]);
  assert.deepEqual(display.covers, [[32, 4, 176, 176]]);
  assert.deepEqual(display.rectangles.slice(1), [[0, 190, 240, 20]]);
});

test("Spotify preview scrolls a long artist independently from a static title", async () => {
  const display = await preview();
  display.run(`status = { snapshot: { status: "playing", nowPlaying: {
    trackId: "track", title: "Title", artist: "A".repeat(40)
  } } }; coverImage = { naturalWidth: 240, naturalHeight: 240 }; drawSpotify(0);
  drawSpotify(1500);`);
  assert.equal(display.texts.length, 3);
  assert.deepEqual(display.texts.slice(2).map(({ value, x, y }) => ({ value, x, y })), [
    { value: "A".repeat(40), x: 5, y: 211 },
  ]);
  assert.deepEqual(display.texts.slice(0, 1).map(({ value, x, y }) => ({ value, x, y })), [
    { value: "Title", x: 8, y: 190 },
  ]);
});

test("Spotify preview resets both marquee positions and delay when the track changes", async () => {
  const display = await preview();
  display.run(`status = { snapshot: { status: "playing", nowPlaying: {
    trackId: "first", title: "T".repeat(50), artist: "A".repeat(40)
  } } }; coverImage = { naturalWidth: 240, naturalHeight: 240 }; drawSpotify(0);
  drawSpotify(1500); drawSpotify(1501); status.snapshot.nowPlaying.trackId = "second"; drawSpotify(2000);
  drawSpotify(3499);`);
  const resetLines = display.texts.slice(-2);
  assert.deepEqual(resetLines.map(({ x, y }) => [x, y]), [[8, 190], [8, 211]]);
  const resetCount = display.texts.length;
  display.run("drawSpotify(3500); drawSpotify(3501);");
  assert.deepEqual(display.texts.slice(resetCount).map(({ x, y }) => [x, y]), [[5, 190], [5, 211]]);
});

test("Spotify preview pauses at the far edge before reversing", async () => {
  const display = await preview();
  display.run(`status = { snapshot: { status: "playing", nowPlaying: {
    trackId: "track", title: "T".repeat(40), artist: "Short"
  } } }; coverImage = { naturalWidth: 240, naturalHeight: 240 }; drawSpotify(0); drawSpotify(1500);
  for (let step = 1; step < 86; step += 1) drawSpotify(1500 + step * 125);`);
  assert.equal(display.texts.at(-1)?.x, -248);
  const loopCount = display.texts.length;
  display.run("drawSpotify(13624);");
  assert.equal(display.texts.length, loopCount);
  display.run("drawSpotify(13625);");
  assert.equal(display.texts.at(-1)?.x, -245);
});

test("Spotify preview restarts timing when delayed artwork appears and on scene reentry", async () => {
  const display = await preview();
  display.run(`status = { snapshot: { status: "playing", nowPlaying: {
    trackId: "track", title: "T".repeat(19), artist: "Short"
  } } }; drawSpotify(0); drawSpotify(1500);`);
  const beforeCover = display.texts.length;
  display.run(`coverImage = { naturalWidth: 240, naturalHeight: 240 }; coverLoadId += 1;
    drawSpotify(1550); drawSpotify(1674);`);
  assert.equal(display.texts.length, beforeCover);
  assert.deepEqual(display.covers, [[32, 4, 176, 176]]);
  display.run("drawSpotify(1675);");
  assert.equal(display.texts.at(-1)?.x, 4);
  display.run("spotifySceneActive = false; drawSpotify(2000);");
  assert.deepEqual(display.texts.slice(-2).map(({ x, y }) => [x, y]), [[8, 190], [8, 211]]);
});
