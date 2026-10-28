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

test("scheduler suspension drains active work and can resume only after an explicit caller action", async () => {
  let active = 0;
  let maximumActive = 0;
  let release: (() => void) | undefined;
  const scheduler = new DeviceScheduler({ intervalMs: 10, synchronize: async () => {
    active++; maximumActive = Math.max(maximumActive, active);
    await new Promise<void>((resolve) => { release = resolve; });
    active--; return true;
  } });
  scheduler.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  const suspension = scheduler.suspendAndDrain();
  release?.();
  await suspension;
  assert.equal(scheduler.status, "disabled");
  assert.equal(active, 0);
  assert.equal(maximumActive, 1);
  scheduler.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  release?.();
  await scheduler.suspendAndDrain();
  assert.equal(maximumActive, 1);
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

test("ready media requests an immediate sequential cycle and cannot restart a suspended scheduler", async () => {
  let calls = 0;
  let release!: () => void;
  const scheduler = new DeviceScheduler({ intervalMs: 60000, synchronize: async () => {
    calls++;
    if (calls === 1) await new Promise<void>((resolve) => { release = resolve; });
    return true;
  } });
  scheduler.start();
  scheduler.requestSynchronization(); scheduler.requestSynchronization();
  await delay(10); assert.equal(calls, 1);
  release();
  await delay(30); assert.equal(calls, 2);
  scheduler.requestSynchronization();
  await scheduler.suspendAndDrain();
  scheduler.requestSynchronization();
  await delay(20); assert.equal(calls, 2);
});
