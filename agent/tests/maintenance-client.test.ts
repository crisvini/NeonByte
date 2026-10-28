import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { MaintenanceClient, MaintenanceRequestError, MaintenanceTransportError } from "../src/device/maintenance-client.js";

const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const localClient = (baseUrl: string, options: { timeoutMs?: number; uploadTimeoutMs?: number } = {}) =>
  new MaintenanceClient({ baseUrl, token, allowLoopbackForTests: true, ...options });
const info = {
  deviceId: "esp8266-a1b2c3", bootId: "0123456789abcdef0123456789abcdef", buildId: "build-20261027-a1b2",
  firmwareVersion: "0.1.0-phase4", stationIp: "192.168.1.20", recoveryApIp: "192.168.4.1",
  otaEnabled: true, maxFirmwareBytes: 458752, profile: "esp8266-dio40-4mb",
  recoveryIdentityFingerprint: "a".repeat(64),
};

async function makeServer(t: TestContext, handler: (request: IncomingMessage, body: Buffer, response: import("node:http").ServerResponse) => void): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      handler(request, Buffer.concat(chunks), response);
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); });
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

test("maintenance GETs authenticate directly and firmware PUT uses exact bounded framing without retry", async (t) => {
  const received: Array<{ method: string; path: string; authorization: string | undefined; length: string | undefined; type: string | undefined; hash: string | undefined; transferEncoding: string | undefined; body: Buffer }> = [];
  const { origin } = await makeServer(t, (request, body, response) => {
    const header = (name: string) => { const value = request.headers[name]; return Array.isArray(value) ? value[0] : value; };
    received.push({ method: request.method ?? "", path: request.url ?? "", authorization: header("authorization"),
      length: header("content-length"), type: header("content-type"), hash: header("x-content-sha256"),
      transferEncoding: header("transfer-encoding"), body });
    if (request.url === "/maintenance/v1/info") response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(info));
    else if (request.url === "/maintenance/v1/status") response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      storageAvailable: true, configurationLoaded: true, applicationRunning: false, recoveryApRunning: true,
      stationConnected: true, pendingWifi: false, volatileWifi: false,
    }));
    else response.writeHead(204).end();
  });
  const client = localClient(origin);
  assert.deepEqual(await client.info(), info);
  await client.status();
  await client.pause();
  const bytes = Buffer.from("approved fixture bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await client.uploadFirmware(bytes, sha256);

  assert.deepEqual(received.map(({ method, path }) => [method, path]), [
    ["GET", "/maintenance/v1/info"], ["GET", "/maintenance/v1/status"],
    ["POST", "/maintenance/v1/pause"], ["PUT", "/maintenance/v1/firmware"],
  ]);
  assert.ok(received.every((request) => request.authorization === `Bearer ${token}`));
  const upload = received[3]!;
  assert.equal(upload.length, String(bytes.length));
  assert.equal(upload.type, "application/octet-stream");
  assert.equal(upload.hash, sha256);
  assert.equal(upload.transferEncoding, undefined);
  assert.deepEqual(upload.body, bytes);
});

test("maintenance client rejects redirects and maps unauthorized responses without remote text", async (t) => {
  let requests = 0;
  const { origin } = await makeServer(t, (_request, _body, response) => {
    requests++;
    response.writeHead(302, { Location: "http://192.168.1.99/maintenance/v1/info" }).end("secret remote detail");
  });
  const client = localClient(origin);
  await assert.rejects(client.info(), (error: unknown) => error instanceof MaintenanceRequestError &&
    error.code === "redirect" && !error.message.includes("secret remote detail"));
  assert.equal(requests, 1);
});

test("a lost firmware response is reported as ambiguous and never resent", async (t) => {
  let firmwareRequests = 0;
  const { origin } = await makeServer(t, (request, _body, response) => {
    if (request.url === "/maintenance/v1/firmware") {
      firmwareRequests++;
      request.socket.destroy();
      return;
    }
    response.writeHead(204).end();
  });
  const client = localClient(origin);
  const bytes = Buffer.from("one transfer only");
  await assert.rejects(client.uploadFirmware(bytes, createHash("sha256").update(bytes).digest("hex")),
    (error: unknown) => error instanceof MaintenanceTransportError && error.requestMayHaveReachedDevice);
  assert.equal(firmwareRequests, 1);
});

test("upload progress reports bounded chunks handed to transport", async (t) => {
  const { origin } = await makeServer(t, (_request, _body, response) => response.writeHead(204).end());
  const bytes = Buffer.alloc(40 * 1024, 0x5a);
  const progress: number[] = [];
  await localClient(origin).uploadFirmware(bytes,
    createHash("sha256").update(bytes).digest("hex"), (sent, total) => {
      assert.equal(total, bytes.length);
      progress.push(sent);
    });
  assert.deepEqual(progress, [16_384, 32_768, 40_960]);
});

test("maintenance requests have an absolute deadline even while response bytes keep arriving", async (t) => {
  const { origin } = await makeServer(t, (_request, _body, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    const interval = setInterval(() => response.write(" "), 5);
    response.on("close", () => clearInterval(interval));
  });
  const client = localClient(origin, { timeoutMs: 40 });
  await assert.rejects(client.info(), (error: unknown) => error instanceof MaintenanceTransportError);
});

test("maintenance client rejects non-private, hostname, and malformed device identities", async (t) => {
  assert.throws(() => new MaintenanceClient({ baseUrl: "http://example.com", token }));
  assert.throws(() => new MaintenanceClient({ baseUrl: "http://8.8.8.8", token }));
  assert.throws(() => new MaintenanceClient({ baseUrl: "http://127.0.0.1", token }));
  const { origin } = await makeServer(t, (_request, _body, response) => {
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ...info, recoveryIdentityFingerprint: "not-a-fingerprint" }));
  });
  await assert.rejects(localClient(origin).info(), /compatible firmware information/);
});
