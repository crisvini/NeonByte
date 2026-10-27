import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("display compatibility probe detects stale 0xc8 MADCTL", {
  skip:
    process.platform === "win32"
      ? "requires the POSIX host compiler used by firmware probes"
      : false,
}, () => {
  const result = spawnSync("python3", ["firmware/scripts/probe_compatibility.py"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const probe = JSON.parse(result.stdout);

  assert.equal(probe.staleMadctlMutationDetected, true);
  assert.equal(probe.display.rotation, 2);
  assert.equal(probe.display.madctl, 8);
});
