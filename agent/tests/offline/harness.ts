import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

export const EPOCH = 1_790_000_000_000;
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
export interface Observation {
  scene: "spotify" | "gif"; waiting: boolean; agentAvailable: boolean; progressMs: number;
  title: string; artist: string; trackId: string; coverTrackId: string; coverPixel: number;
  animationFrames: number; animationSha: string; savedSsid: string; calls: string;
  attempts: number; applicationRunning: boolean;
}
interface NativeResponse { status: number; bodyHex: string }
interface Frame { ok: boolean; bytes: number; delayMs: number; sha256: string }

class NativeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private queue: Promise<unknown> = Promise.resolve();
  private receiver: { resolve(value: unknown): void; reject(error: Error): void } | null = null;
  private failure: Error | null = null;

  constructor(directory: string) {
    this.child = spawn(fileURLToPath(new URL("../../../build/neonbyte-host", import.meta.url)), [directory], { stdio: "pipe" });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try { this.receiver?.resolve(JSON.parse(line)); }
      catch { this.receiver?.reject(new Error("Invalid native harness response.")); }
      this.receiver = null;
    });
    let stderr = "";
    this.child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const failed = (error: Error) => { this.failure = error; this.receiver?.reject(error); this.receiver = null; };
    this.child.on("error", failed);
    this.child.on("exit", (code, signal) => {
      failed(new Error(`Native harness exited (${code ?? signal}). ${stderr}`));
    });
    this.child.stdin.on("error", failed);
  }

  send<T>(bytes: Buffer | string): Promise<T> {
    const result = this.queue.then(() => new Promise<T>((resolve, reject) => {
      if (this.failure) { reject(this.failure); return; }
      const timeout = setTimeout(() => {
        this.receiver = null; this.child.kill(); reject(new Error("Native harness response timed out."));
      }, 5_000);
      this.receiver = {
        resolve: (value) => { clearTimeout(timeout); resolve(value as T); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      };
      this.child.stdin.write(bytes);
    }));
    this.queue = result.catch(() => undefined); return result;
  }
  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, "exit");
    this.child.stdin.end();
    const timeout = setTimeout(() => { this.child.kill("SIGKILL"); }, 2_000);
    await exited; clearTimeout(timeout);
    if (this.failure && this.child.exitCode !== 0) throw this.failure;
  }
  async crash(): Promise<void> {
    const exited = once(this.child, "exit"); this.child.kill("SIGKILL"); await exited;
  }
}

export class Harness {
  readonly token = TOKEN;
  readonly requests: Array<{ method: string; path: string }> = [];
  url = "";
  offline = false;
  statusOverride: unknown = undefined;
  private native: NativeProcess;
  private server: Server | null = null;
  private unixMs = EPOCH;

  constructor(readonly directory: string) { this.native = new NativeProcess(directory); }
  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void (async () => {
        this.requests.push({ method: request.method!, path: request.url! });
        if (this.offline) { request.resume(); response.writeHead(503).end(); return; }
        if (this.statusOverride !== undefined && request.url === "/api/v1/status") {
          response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(this.statusOverride)); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 2_304_051) throw new Error("Host body limit exceeded.");
          chunks.push(Buffer.from(chunk));
        }
        const headers: string[] = [];
        for (let index = 0; index < request.rawHeaders.length; index += 2)
          headers.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
        const native = await this.raw(`${request.method} ${request.url} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`, Buffer.concat(chunks));
        response.writeHead(native.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(Buffer.from(native.bodyHex, "hex"));
      })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
    });
    this.server.listen(0, "127.0.0.1"); await once(this.server, "listening");
    const address = this.server.address(); assert.ok(address && typeof address !== "string");
    this.url = `http://127.0.0.1:${address.port}`;
  }
  raw(header: string, body = Buffer.alloc(0), cut = false): Promise<NativeResponse> {
    const bytes = Buffer.from(header);
    return this.native.send(Buffer.concat([Buffer.from(`${cut ? "CUT" : "REQUEST"} ${bytes.length} ${body.length}\n`), bytes, body]));
  }
  async state(): Promise<Observation> {
    const value = await this.native.send<Record<string, unknown>>("STATE\n");
    for (const field of ["title", "artist", "trackId", "coverTrackId", "savedSsid"]) {
      value[field] = Buffer.from(String(value[`${field}Hex`]), "hex").toString("utf8");
      delete value[`${field}Hex`];
    }
    return value as unknown as Observation;
  }
  async advance(ms: number): Promise<void> { await this.native.send(`ADVANCE ${ms}\n`); this.unixMs += ms; }
  async fault(name: string, enabled: boolean | number): Promise<void> { await this.native.send(`FAULT ${name} ${Number(enabled)}\n`); }
  async associate(ssid: string): Promise<void> { await this.native.send(`ASSOCIATE ${Buffer.from(ssid).toString("hex")}\n`); }
  frame(index: number): Promise<Frame> { return this.native.send(`FRAME ${index}\n`); }
  async maintenance(path: string, body?: string, token = TOKEN): Promise<Response> {
    const method = path === "status" ? "GET" : body === undefined ? "POST" : "PUT";
    return fetch(`${this.url}/maintenance/v1/${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, ...(method === "GET" ? {} : { "Content-Length": String(Buffer.byteLength(body ?? "")) }),
        ...(body === undefined ? {} : { "Content-Type": "application/x-www-form-urlencoded" }) },
      ...(body === undefined ? {} : { body }),
    });
  }
  async bootstrap(): Promise<void> {
    assert.equal((await this.maintenance("wifi", "ssid=OfflineLab&password=test-password")).status, 204);
    await this.associate("OfflineLab");
    assert.equal((await this.maintenance("wifi/confirm")).status, 204);
    assert.equal((await this.maintenance("run")).status, 204);
  }
  async restart(run = true, crash = false): Promise<void> {
    if (crash) await this.native.crash(); else await this.native.close();
    this.native = new NativeProcess(this.directory);
    await this.native.send(`UNIX ${this.unixMs}\n`);
    if (run) assert.equal((await this.maintenance("run")).status, 204);
  }
  async close(): Promise<void> {
    if (this.server) {
      const server = this.server;
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    }
    await this.native.close();
  }
}

export async function startHarness(t: TestContext, options: { bootstrap?: boolean } = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "neonbyte-offline-"));
  const harness = new Harness(directory);
  t.after(async () => { try { await harness.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  await harness.start();
  if (options.bootstrap !== false) await harness.bootstrap();
  return harness;
}
