import { isIP } from "node:net";
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";

export const MAX_PREPARATION_FIRMWARE_BYTES = 458_752;
export const FIRMWARE_HTTP_TIMEOUT_MS = 75_000;
export const MAINTENANCE_HTTP_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 8_192;

export interface MaintenanceInfo {
  deviceId: string;
  bootId: string;
  buildId: string;
  firmwareVersion: string;
  stationIp: string;
  recoveryApIp: string;
  otaEnabled: boolean;
  maxFirmwareBytes: number;
  profile: string;
  recoveryIdentityFingerprint: string;
}

export interface MaintenanceStatus {
  storageAvailable: boolean;
  configurationLoaded: boolean;
  applicationRunning: boolean;
  recoveryApRunning: boolean;
  stationConnected: boolean;
  pendingWifi: boolean;
  volatileWifi: boolean;
}

export interface MaintenanceDiagnostics {
  freeHeapBytes: number;
  maxFreeBlockBytes: number;
  resetReason: number;
  connectionsAccepted: number;
  connectionsDisconnected: number;
  idleTimeouts: number;
  totalTimeouts: number;
  uploadsStarted: number;
  uploadsAborted: number;
  uploadsCompleted: number;
  uploadFailures: number;
  uploadBytes: number;
  maxLoopGapMs: number;
}

export type MaintenanceErrorCode = "unauthorized" | "disabled" | "conflict" | "too_large" |
  "invalid_firmware" | "unsupported_firmware" | "redirect" | "rejected";

export class MaintenanceRequestError extends Error {
  constructor(readonly code: MaintenanceErrorCode) {
    super(safeMessage(code));
    this.name = "MaintenanceRequestError";
  }
}

export class MaintenanceTransportError extends Error {
  constructor(readonly requestMayHaveReachedDevice: boolean) {
    super("The maintenance response was lost. Check the device before any manual retry.");
    this.name = "MaintenanceTransportError";
  }
}

function safeMessage(code: MaintenanceErrorCode): string {
  switch (code) {
    case "unauthorized": return "Maintenance credentials were rejected. Verify enrollment in the foreground agent terminal.";
    case "disabled": return "Verified firmware updates are disabled for this device build.";
    case "conflict": return "The device rejected this maintenance operation in its current state.";
    case "too_large": return "The firmware exceeds the approved size limit.";
    case "invalid_firmware": return "The device rejected the firmware image. Maintenance remains available.";
    case "unsupported_firmware": return "This firmware does not support verified dashboard updates.";
    case "redirect": return "The device returned a redirect; maintenance requests never follow redirects.";
    case "rejected": return "The device rejected the maintenance request without exposing its response body.";
  }
}

function isPrivateIpv4(value: string, allowUnassigned = false): boolean {
  if (allowUnassigned && value === "0.0.0.0") return true;
  if (isIP(value) !== 4) return false;
  const octets = value.split(".").map(Number);
  const first = octets[0]!, second = octets[1]!;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function isLoopbackIpv4(value: string): boolean { return isIP(value) === 4 && Number(value.split(".")[0]) === 127; }

export function validateMaintenanceOrigin(value: string, options: { allowLoopbackForTests?: boolean } = {}): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Use a private IPv4 HTTP origin for the maintenance device."); }
  const authority = value.match(/^http:\/\/([^/?#]+)/i)?.[1] ?? "";
  const rawHostname = authority.replace(/:\d+$/, "");
  if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      isIP(rawHostname) !== 4 || !(isPrivateIpv4(rawHostname) || (options.allowLoopbackForTests === true && isLoopbackIpv4(rawHostname))) ||
      url.hostname !== rawHostname) {
    throw new Error("Use a private IPv4 HTTP origin for the maintenance device.");
  }
  return url;
}

function safeIdentifier(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && /^[A-Za-z0-9._:-]+$/.test(value);
}

function validInfo(value: unknown): value is MaintenanceInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = ["deviceId", "bootId", "buildId", "firmwareVersion", "stationIp", "recoveryApIp", "otaEnabled",
    "maxFirmwareBytes", "profile", "recoveryIdentityFingerprint"];
  if (Object.keys(item).length !== keys.length || !keys.every((key) => Object.hasOwn(item, key))) return false;
  const validAtomOrEmpty = (field: unknown, max: number) => field === "" || safeIdentifier(field, max);
  if (!safeIdentifier(item["deviceId"], 64) || !safeIdentifier(item["bootId"], 64) ||
      !validAtomOrEmpty(item["buildId"], 96) || !safeIdentifier(item["firmwareVersion"], 64) ||
      !isPrivateIpv4(String(item["stationIp"]), true) || !isPrivateIpv4(String(item["recoveryApIp"]), true) ||
      typeof item["otaEnabled"] !== "boolean" || !Number.isSafeInteger(item["maxFirmwareBytes"]) ||
      Number(item["maxFirmwareBytes"]) < 0 || Number(item["maxFirmwareBytes"]) > 524_288 ||
      !validAtomOrEmpty(item["profile"], 96)) return false;
  const fingerprint = item["recoveryIdentityFingerprint"];
  const validFingerprint = fingerprint === "" || (typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint));
  if (!validFingerprint) return false;
  return item["otaEnabled"]
    ? safeIdentifier(item["buildId"], 96) && safeIdentifier(item["profile"], 96) && typeof fingerprint === "string" && fingerprint.length === 64 && Number(item["maxFirmwareBytes"]) > 0
    : Number(item["maxFirmwareBytes"]) === 0;
}

function validStatus(value: unknown): value is MaintenanceStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = ["storageAvailable", "configurationLoaded", "applicationRunning", "recoveryApRunning", "stationConnected", "pendingWifi", "volatileWifi"];
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === keys.length && keys.every((key) => typeof item[key] === "boolean");
}

function validDiagnostics(value: unknown): value is MaintenanceDiagnostics {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = ["freeHeapBytes", "maxFreeBlockBytes", "resetReason", "connectionsAccepted", "connectionsDisconnected", "idleTimeouts", "totalTimeouts",
    "uploadsStarted", "uploadsAborted", "uploadsCompleted", "uploadFailures", "uploadBytes", "maxLoopGapMs"];
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === keys.length && keys.every((key) => Number.isSafeInteger(item[key]) && Number(item[key]) >= 0 && Number(item[key]) <= 0xffff_ffff);
}

interface RawResponse { status: number; headers: IncomingHttpHeaders; body: Buffer }

export class MaintenanceClient {
  private readonly baseUrl: URL;

  constructor(private readonly options: { baseUrl: string; token: string; timeoutMs?: number; uploadTimeoutMs?: number; allowLoopbackForTests?: boolean }) {
    this.baseUrl = validateMaintenanceOrigin(options.baseUrl, { allowLoopbackForTests: options.allowLoopbackForTests === true });
    if (!/^[a-f0-9]{64}$/.test(options.token)) throw new Error("Provide a valid recovery credential in the foreground enrollment flow.");
    if (!Number.isSafeInteger(options.timeoutMs ?? MAINTENANCE_HTTP_TIMEOUT_MS) || (options.timeoutMs ?? MAINTENANCE_HTTP_TIMEOUT_MS) < 1 ||
        !Number.isSafeInteger(options.uploadTimeoutMs ?? FIRMWARE_HTTP_TIMEOUT_MS) || (options.uploadTimeoutMs ?? FIRMWARE_HTTP_TIMEOUT_MS) < 1) {
      throw new Error("Use positive maintenance request deadlines.");
    }
  }

  private async request(method: "GET" | "POST" | "PUT", path: string, body?: Buffer, headers: Record<string, string> = {},
    timeoutMs?: number, onProgress?: (bytesSent: number, totalBytes: number) => void): Promise<RawResponse> {
    const payload = body ?? Buffer.alloc(0);
    const address = new URL(path, this.baseUrl);
    const requestOptions: RequestOptions = {
      method,
      hostname: this.baseUrl.hostname,
      port: this.baseUrl.port || 80,
      path: address.pathname,
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        ...(method === "GET" ? {} : { "Content-Length": String(payload.length) }),
        ...headers,
      },
    };

    return await new Promise<RawResponse>((resolve, reject) => {
      let settled = false;
      const deadlineMs = timeoutMs ?? (method === "PUT" ? this.options.uploadTimeoutMs ?? FIRMWARE_HTTP_TIMEOUT_MS : this.options.timeoutMs ?? MAINTENANCE_HTTP_TIMEOUT_MS);
      const request = httpRequest(requestOptions, (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.length;
          if (total > MAX_RESPONSE_BYTES) {
            request.destroy();
            if (!settled) { settled = true; clearTimeout(totalTimer); reject(new MaintenanceTransportError(method === "PUT")); }
            return;
          }
          chunks.push(bytes);
        });
        response.on("error", () => {
          if (!settled) { settled = true; clearTimeout(totalTimer); reject(new MaintenanceTransportError(method === "PUT")); }
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(totalTimer);
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks, total) });
        });
      });
      const totalTimer = setTimeout(() => request.destroy(new Error("timeout")), deadlineMs);
      request.setTimeout(Math.min(deadlineMs, method === "PUT" ? 10_000 : deadlineMs),
        () => request.destroy(new Error("timeout")));
      request.on("error", () => {
        if (!settled) { settled = true; clearTimeout(totalTimer); reject(new MaintenanceTransportError(method === "PUT")); }
      });

      void (async () => {
        try {
          if (method === "PUT") {
            for (let offset = 0; offset < payload.length; offset += 16 * 1024) {
              const chunk = payload.subarray(offset, Math.min(payload.length, offset + 16 * 1024));
              const canContinue = request.write(chunk);
              onProgress?.(offset + chunk.length, payload.length);
              if (!canContinue) await once(request, "drain");
            }
          } else if (payload.length) request.write(payload);
          request.end();
        } catch {
          request.destroy(new Error("transport"));
        }
      })();
    });
  }

  private async expect(method: "GET" | "POST" | "PUT", path: string, body?: Buffer, headers?: Record<string, string>, timeoutMs?: number): Promise<RawResponse> {
    const response = await this.request(method, path, body, headers, timeoutMs);
    const expected = method === "GET" ? 200 : 204;
    if (response.status === expected) return response;
    if (response.status >= 300 && response.status < 400) throw new MaintenanceRequestError("redirect");
    if (response.status === 401) throw new MaintenanceRequestError("unauthorized");
    if (response.status === 404) throw new MaintenanceRequestError("unsupported_firmware");
    if (response.status === 409) throw new MaintenanceRequestError("conflict");
    if (response.status === 413) throw new MaintenanceRequestError("too_large");
    if (response.status === 415 || response.status === 422) throw new MaintenanceRequestError("invalid_firmware");
    if (response.status === 400 || response.status === 403) throw new MaintenanceRequestError("rejected");
    throw new MaintenanceRequestError("rejected");
  }

  private parseJson(response: RawResponse): unknown {
    const contentType = String(response.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json") throw new Error("The device returned an invalid maintenance response.");
    try { return JSON.parse(response.body.toString("utf8")) as unknown; }
    catch { throw new Error("The device returned invalid maintenance information."); }
  }

  async info(timeoutMs?: number): Promise<MaintenanceInfo> {
    const value = this.parseJson(await this.expect("GET", "/maintenance/v1/info", undefined, undefined, timeoutMs));
    if (!validInfo(value)) throw new Error("The device did not return compatible firmware information.");
    return value;
  }

  async status(timeoutMs?: number): Promise<MaintenanceStatus> {
    const value = this.parseJson(await this.expect("GET", "/maintenance/v1/status", undefined, undefined, timeoutMs));
    if (!validStatus(value)) throw new Error("The device did not return compatible maintenance status.");
    return value;
  }

  async diagnostics(timeoutMs?: number): Promise<MaintenanceDiagnostics> {
    const value = this.parseJson(await this.expect("GET", "/maintenance/v1/diagnostics", undefined, undefined, timeoutMs));
    if (!validDiagnostics(value)) throw new Error("The device did not return compatible maintenance diagnostics.");
    return value;
  }

  async pause(): Promise<void> { await this.expect("POST", "/maintenance/v1/pause", Buffer.alloc(0)); }
  async run(): Promise<void> { await this.expect("POST", "/maintenance/v1/run", Buffer.alloc(0)); }

  async uploadFirmware(bytes: Buffer, sha256: string, onProgress?: (bytesSent: number, totalBytes: number) => void): Promise<void> {
    if (bytes.length < 1 || bytes.length > MAX_PREPARATION_FIRMWARE_BYTES || !/^[a-f0-9]{64}$/.test(sha256) ||
        createHash("sha256").update(bytes).digest("hex") !== sha256) {
      throw new MaintenanceRequestError("invalid_firmware");
    }
    const headers = { "Content-Type": "application/octet-stream", "X-Content-SHA256": sha256 };
    const response = await this.request("PUT", "/maintenance/v1/firmware", bytes, headers,
      this.options.uploadTimeoutMs ?? FIRMWARE_HTTP_TIMEOUT_MS, onProgress);
    if (response.status === 204) return;
    if (response.status >= 300 && response.status < 400) throw new MaintenanceRequestError("redirect");
    if (response.status === 401) throw new MaintenanceRequestError("unauthorized");
    if (response.status === 404) throw new MaintenanceRequestError("unsupported_firmware");
    if (response.status === 409) throw new MaintenanceRequestError("disabled");
    if (response.status === 413) throw new MaintenanceRequestError("too_large");
    if (response.status === 422) throw new MaintenanceRequestError("invalid_firmware");
    throw new MaintenanceRequestError("rejected");
  }
}
