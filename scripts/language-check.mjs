import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rulesPath = path.join(projectRoot, "scripts", "language-check-rules.json");
const { words, ignoredPhrases } = JSON.parse(readFileSync(rulesPath, "utf8"));
const textExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".js",
  ".json",
  ".jsonc",
  ".md",
  ".mjs",
  ".sh",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const ignoredDirectoryNames = new Set([
  ".git",
  ".pio",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const ignoredFileNames = new Set([
  "language-check-rules.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const textFileNames = new Set([
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  "Dockerfile",
  "LICENSE",
  "Makefile",
]);
const urlPattern = /https?:\/\/[^\s)\]}>]+/giu;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const wordPatterns = words.map((word) => ({
  word,
  pattern: new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(word)}(?![\\p{L}\\p{N}_])`, "giu"),
}));
const ignoredPhrasePatterns = ignoredPhrases.map((phrase) =>
  new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}_])`, "giu"),
);

export function isScannableFile(filePath) {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const segments = normalizedPath.split("/");
  const baseName = path.posix.basename(normalizedPath);

  if (segments.some((segment) => ignoredDirectoryNames.has(segment))) return false;
  if (ignoredFileNames.has(baseName) || baseName === ".env") return false;
  if (baseName === ".env.example" || textFileNames.has(baseName)) return true;
  return textExtensions.has(path.posix.extname(normalizedPath).toLowerCase());
}

export function findPortugueseContent(content) {
  return content.split(/\r?\n/u).flatMap((line, index) => {
    let searchableLine = line.replace(urlPattern, " ");
    for (const pattern of ignoredPhrasePatterns) {
      searchableLine = searchableLine.replace(pattern, " ");
    }
    searchableLine = searchableLine
      .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
      .replace(/([A-Z])([A-Z][a-z])/gu, "$1 $2")
      .replace(/[_-]+/gu, " ");
    for (const pattern of ignoredPhrasePatterns) {
      searchableLine = searchableLine.replace(pattern, " ");
    }

    const foundWords = new Map();
    for (const { word, pattern } of wordPatterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(searchableLine);
      if (match) foundWords.set(word, match.index);
    }

    const orderedWords = [...foundWords]
      .sort((left, right) => left[1] - right[1])
      .map(([word]) => word);
    return orderedWords.length > 0 ? [{ line: index + 1, words: orderedWords }] : [];
  });
}

function collectFiles(directoryPath, relativeDirectory = "") {
  return readdirSync(directoryPath, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    const absolutePath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      if (ignoredDirectoryNames.has(entry.name)) return [];
      return collectFiles(absolutePath, relativePath);
    }

    return entry.isFile() && isScannableFile(relativePath) ? [relativePath] : [];
  });
}

export function scanProject(root = projectRoot) {
  return collectFiles(root)
    .sort()
    .flatMap((relativePath) => {
      const content = readFileSync(path.join(root, relativePath), "utf8");
      return findPortugueseContent(content).map((match) => ({ file: relativePath, ...match }));
    });
}

function reportViolations(violations) {
  console.error("Language check failed: possible Portuguese content was found.");
  for (const { file, line, words: foundWords } of violations) {
    console.error(`  ${file}:${line}: ${foundWords.join(", ")}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = scanProject();
  if (violations.length > 0) {
    reportViolations(violations);
    process.exitCode = 1;
  } else {
    console.log("Language check passed.");
  }
}
