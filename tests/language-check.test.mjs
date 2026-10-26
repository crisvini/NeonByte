import assert from "node:assert/strict";
import test from "node:test";
import { findPortugueseContent, isScannableFile } from "../scripts/language-check.mjs";

test("detects high-confidence Portuguese words and reports their line numbers", () => {
  const localizedWord = ["dis", "positivo"].join("");
  const additionalMarker = ["atual", "izado"].join("");
  const intervalMarker = ["inter", "valo"].join("");
  const consumerMarker = ["consu", "midor"].join("");
  const content = `English documentation.\nThe ${localizedWord} n\u00e3o responds.`;

  assert.deepEqual(findPortugueseContent(content), [
    { line: 2, words: [localizedWord, "n\u00e3o"] },
  ]);
  assert.deepEqual(findPortugueseContent(`Spotify state ${additionalMarker}.`), [
    { line: 1, words: [additionalMarker] },
  ]);
  assert.deepEqual(findPortugueseContent(`The ${intervalMarker} and ${consumerMarker} values.`), [
    { line: 1, words: [intervalMarker, consumerMarker] },
  ]);
  const modeMarker = ["mo", "do"].join("");
  const screenMarker = ["te", "la"].join("");
  const camelIdentifier = `screen${modeMarker[0].toUpperCase()}${modeMarker.slice(1)}`;
  const snakeIdentifier = [modeMarker, screenMarker].join("_");
  assert.deepEqual(findPortugueseContent(`${camelIdentifier} ${snakeIdentifier}`), [
    { line: 1, words: [modeMarker, screenMarker] },
  ]);
});

test("ignores URLs, proper names, and established technical terms", () => {
  const urlPath = ["eta", "pa"].join("");
  const placeName = `S\u00e3o Paulo`;
  const content = `JUZIPi and Spotify use OAuth. ${placeName}. https://example.test/${urlPath}`;

  assert.deepEqual(findPortugueseContent(content), []);
  assert.deepEqual(findPortugueseContent(`The levels s\u00e3o balanced.`), [
    { line: 1, words: ["s\u00e3o"] },
  ]);
});

test("scans project text and source files while excluding generated and binary files", () => {
  assert.equal(isScannableFile("docs/protocol.md"), true);
  assert.equal(isScannableFile("agent/src/main.ts"), true);
  assert.equal(isScannableFile("contracts/v1/status.schema.json"), true);
  assert.equal(isScannableFile(".gitignore"), true);
  assert.equal(isScannableFile("node_modules/package/readme.md"), false);
  assert.equal(isScannableFile("agent/dist/main.js"), false);
  assert.equal(isScannableFile("agent/package-lock.json"), false);
  assert.equal(isScannableFile("node_modules\\package\\readme.md"), false);
  assert.equal(isScannableFile("assets/sample.gif"), false);
  assert.equal(isScannableFile("scripts/language-check-rules.json"), false);
});
