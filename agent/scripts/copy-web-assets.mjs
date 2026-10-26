import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const source = resolve(scriptDirectory, "../src/web/public");
const destination = resolve(scriptDirectory, "../dist/web/public");

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });
