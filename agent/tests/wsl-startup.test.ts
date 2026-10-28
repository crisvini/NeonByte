import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("WSL launcher uses explicit paths, records output, and propagates failures", {
  skip: process.platform === "win32" ? "The WSL launcher is a POSIX shell script" : false,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), "neonbyte startup "));
  try {
    const root = join(base, "checkout");
    const home = join(base, "home");
    await mkdir(join(root, "agent", "dist"), { recursive: true });
    await mkdir(home);
    const node = join(base, "fake node");
    await writeFile(node, '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 7\n', { mode: 0o755 });
    const result = spawnSync("sh", [resolve("startup/wsl-launch.sh"), root, node], { env: { ...process.env, HOME: home, XDG_STATE_HOME: join(home, "state") }, encoding: "utf8" });
    assert.equal(result.status, 7);
    const log = await readFile(join(home, "state", "neonbyte", "agent.log"), "utf8");
    assert.match(log, /--env-file-if-exists=/);
    assert.ok(log.includes(join(root, "agent", "dist", "main.js")));
    assert.match(log, /\nrun\n/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
