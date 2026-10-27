import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireInstance } from "../src/instance.js";

test("only one agent owns the instance lock and it can be reacquired after release", async () => {
  const first = await acquireInstance(0);
  try {
    await assert.rejects(acquireInstance(first.port), /already running/);
  } finally {
    await first.close();
  }
  const restarted = await acquireInstance(first.port);
  await restarted.close();
});
