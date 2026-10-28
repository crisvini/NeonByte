import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRepresentativeCorpus,
  benchmarkScenario,
  decodeBenchmarkNbifV2,
} from "../scripts/benchmark-animation.js";
import { convertGifToAnimation } from "../src/media/animation.js";

test("benchmark corpus contains exact fourteen-frame GIF inputs with short-motion and full-motion cases", () => {
  const corpus = buildRepresentativeCorpus();

  assert.ok(corpus.length >= 4);
  assert.ok(corpus.every((item) => item.frames.length === 14));
  assert.ok(corpus.every((item) => item.delaysMs.length === 14));
  assert.ok(corpus.some((item) => item.name.includes("small-motion")));
  assert.ok(corpus.some((item) => item.name.includes("full-motion")));
  for (const item of corpus) {
    const legacy = convertGifToAnimation(item.gifBytes);
    assert.equal(legacy.frameCount, 14);
    assert.deepEqual(item.frames, Array.from({ length: 14 }, (_, index) =>
      legacy.bytes.subarray(13 + index * (2 + 240 * 240 * 2), 13 + index * (2 + 240 * 240 * 2) + 240 * 240 * 2)));
  }
});

test("benchmark reports direct GIF, palette-only, RLE delta and full NBIF v2 sizes", () => {
  const corpus = buildRepresentativeCorpus();
  for (const item of corpus) {
    const result = benchmarkScenario(item);
    assert.equal(result.sourceGifBytes, item.gifBytes.length);
    assert.ok(result.directGifBytes > 0);
    assert.ok(result.legacyRgb565Bytes > result.sourceGifBytes);
    assert.ok(result.paletteFullBytes > 0);
    assert.ok(result.rgb565RleDeltaBytes > 0);
    assert.ok(result.nbifV2Bytes > 0);
    assert.equal(result.reconstructedExactly, true);
  }
});

test("benchmark v2 decoder reconstructs every row, color, frame and original delay", () => {
  for (const item of buildRepresentativeCorpus()) {
    const result = benchmarkScenario(item);
    const decoded = decodeBenchmarkNbifV2(result.nbifV2);

    assert.deepEqual(decoded.frames, item.frames, item.name);
    assert.deepEqual(decoded.delaysMs, item.delaysMs, item.name);
    assert.equal(decoded.durationMs, item.delaysMs.reduce((total, delay) => total + delay, 0));
  }
});
