import assert from "node:assert/strict";
import test from "node:test";
import { DeviceClient } from "../src/device/client.js";

const status = { protocolVersion: "v1", firmwareVersion: "host", ip: "127.0.0.1", freeStorageBytes: 1_000_000, mode: "auto", activeScene: "gif" };

test("device mutations stop on incompatible or malformed status before disclosing pairing credentials", async () => {
  for (const invalid of [{ ...status, protocolVersion: "v2" }, { ...status, freeStorageBytes: -1 }, { ...status, extra: true }, { ...status, mode: "unknown" },
    { ...status, mode: ["gif"] }, { ...status, activeScene: ["gif"] },
    { ...status, ip: "x".repeat(65) }, { ...status, firmwareVersion: "x".repeat(65) }]) {
    const requests: RequestInit[] = [];
    const client = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token: "public-test-pairing", fetchDevice: async (_input, init) => {
      requests.push(init!); return new Response(JSON.stringify(invalid));
    } });
    await assert.rejects(client.heartbeat(), /compatible protocol v1/);
    assert.equal(requests.length, 1);
    assert.equal(new Headers(requests[0]!.headers).has("Authorization"), false);
  }
});

test("device request deadlines and rejected remote responses produce safe errors", async () => {
  const token = "public-test-secret-placeholder";
  const deadline = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token, timeoutMs: 10,
    fetchDevice: async (_input, init) => {
      assert.equal(init?.redirect, "error");
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error(token)), { once: true });
        // Keep this deterministic test alive while AbortSignal's unreferenced deadline fires.
        const timer = setTimeout(() => reject(new Error("Deadline failed to abort.")), 500);
        init?.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
      });
    } });
  await assert.rejects(deadline.status(), (error: Error) => !error.message.includes(token) && /compatible/.test(error.message));
  const rejected = new DeviceClient({ baseUrl: "http://127.0.0.1:1", token,
    fetchDevice: async (_input, init) => init?.method === "GET" ? new Response(JSON.stringify(status)) : new Response(token, { status: 401 }) });
  await assert.rejects(rejected.heartbeat(), (error: Error) => !error.message.includes(token) && /communication failed/.test(error.message));
});

test("device client rejects public and hostname destinations before sending credentials", () => {
  for (const address of ["http://example.com", "http://8.8.8.8", "http://169.254.169.254", "http://[::ffff:8.8.8.8]", "http://192.168.1.1.example.com"]) {
    assert.throws(() => new DeviceClient({ baseUrl: address, token: "test-secret" }), /local|private/i);
  }
  for (const address of ["http://127.0.0.1:1", "http://10.1.2.3", "http://172.16.0.1", "http://192.168.1.2", "http://[::1]"]) {
    assert.doesNotThrow(() => new DeviceClient({ baseUrl: address, token: "test-secret" }));
  }
});
