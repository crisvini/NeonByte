import assert from "node:assert/strict";
import test from "node:test";
import { DeviceScheduler } from "../src/device/scheduler.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("scheduler stays inactive until started, retries failures, and stops", async () => {
  let calls = 0;
  const scheduler = new DeviceScheduler({ intervalMs: 10, synchronize: async () => ++calls > 1 });
  await delay(20);
  assert.equal(calls, 0);
  assert.equal(scheduler.status, "disabled");
  scheduler.start();
  await delay(40);
  assert.ok(calls >= 2);
  assert.equal(scheduler.status, "connected");
  await scheduler.stop();
  const stopped = calls;
  await delay(25);
  assert.equal(calls, stopped);
  assert.equal(scheduler.status, "disabled");
});

test("scheduler never overlaps synchronization and waits for shutdown", async () => {
  let release!: () => void;
  let calls = 0;
  const scheduler = new DeviceScheduler({ intervalMs: 10, synchronize: async () => {
    calls += 1;
    await new Promise<void>((resolve) => { release = resolve; });
    return true;
  } });
  scheduler.start();
  await delay(30);
  assert.equal(calls, 1);
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await delay(10);
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(scheduler.status, "disabled");
  await delay(20);
  assert.equal(calls, 1);
});

test("scheduler reports exceptions as disconnected and retries", async () => {
  let calls = 0;
  const scheduler = new DeviceScheduler({ intervalMs: 15, synchronize: async () => {
    calls += 1;
    throw new Error("secret remote error");
  } });
  scheduler.start();
  await delay(10);
  assert.equal(scheduler.status, "disconnected");
  await delay(30);
  assert.ok(calls >= 2);
  await scheduler.stop();
});
