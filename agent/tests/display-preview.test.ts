import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function preview() {
  const rectangles: number[][] = [];
  const covers: number[][] = [];
  const texts: Array<{ value: string; x: number; y: number; font: string }> = [];
  const context = {
    font: "", fillStyle: "", textAlign: "", textBaseline: "",
    fillRect: (...args: number[]) => rectangles.push(args),
    fillText(value: string, x: number, y: number) { texts.push({ value, x, y, font: this.font }); },
    measureText: (value: string) => ({ width: [...value].length * 6 }),
    save() {}, restore() {}, beginPath() {}, roundRect() {}, clip() {},
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
    localStorage: { getItem: () => null },
    fetch: () => new Promise(() => {}),
  });
  const source = await readFile(new URL("../src/web/public/app.js", import.meta.url), "utf8");
  vm.runInContext(source, sandbox);
  return { rectangles, covers, texts, element, run: (script: string) => vm.runInContext(script, sandbox) };
}

test("Spotify preview enlarges the cover, keeps font sizes and omits progress and time", async () => {
  const display = await preview();
  display.run(`status = { snapshot: { status: "playing", nowPlaying: {
    trackId: "track", title: "Title", artist: "Artist", isPlaying: true,
    durationMs: 180000, progressMs: 1000, sampledAtUnixMs: 1000
  } } }; coverImage = { naturalWidth: 240, naturalHeight: 240 }; drawSpotify(1000);`);
  assert.deepEqual(display.covers, [[32, 4, 176, 176]]);
  assert.equal(display.texts[0]?.font, "600 12px system-ui, sans-serif");
  assert.equal(display.texts[1]?.font, "10px system-ui, sans-serif");
  assert.deepEqual(display.texts.map((text) => text.value), ["Title", "Artist"]);
  assert.deepEqual(display.rectangles, [[0, 0, 240, 240]]);
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

test("Spotify preview uses two bounded lines per long name and safe Unicode truncation", async () => {
  const display = await preview();
  display.run(`status = { snapshot: { status: "playing", nowPlaying: {
    title: "🎵".repeat(100), artist: "A".repeat(100)
  } } }; coverImage = { naturalWidth: 240, naturalHeight: 240 }; drawSpotify(1000);`);
  assert.equal(display.texts.length, 4);
  for (const text of display.texts) {
    assert.ok([...text.value].length * 6 <= 224);
    assert.ok(text.y >= 188 && text.y + (text.font.startsWith("600") ? 12 : 10) <= 240);
    assert.equal(Buffer.from(text.value, "utf8").toString("utf8"), text.value);
  }
  assert.match(display.texts[1]!.value, /…$/);
  assert.match(display.texts[3]!.value, /…$/);
});
