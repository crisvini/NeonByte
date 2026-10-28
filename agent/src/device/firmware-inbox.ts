import { randomUUID, createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, readdir } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MAX_PREPARATION_FIRMWARE_BYTES } from "./maintenance-client.js";
import type { RecoveryCredential } from "./recovery-store.js";

const execFile = promisify(execFileCallback);
const MANIFEST_LIMIT_BYTES = 16 * 1024;
const FILE_READ_CHUNK_BYTES = 64 * 1024;

export interface FirmwareManifest {
  schemaVersion: 1;
  fileName: "firmware.bin";
  byteLength: number;
  sha256: string;
  imageFormat: "esp8266-combined-e9";
  firmwareVersion: string;
  buildId: string;
  deviceId: string;
  profile: string;
  recoveryIdentityFingerprint: string;
  sourceRevision: string;
  target: { family: "esp8266"; flashMode: "dio"; flashFrequencyMHz: 40; flashBytes: 4_194_304 };
  linkedRegions: { bootloaderStart: 0; applicationStart: 4096; filesystemStart: number; filesystemEnd: number; eepromStart: number };
  featureGates: { maintenanceOnBoot: boolean; otaEnabled: boolean };
  minimumResources: { minimumFreeHeapBytes: number; minimumLargestBlockBytes: number };
  validation: { combinedImage: true; modernCrc: true; runtimeBounds: true; recoveryIdentity: true };
}

export interface PreparedFirmwareCandidate {
  id: string;
  fileName: "firmware.bin";
  byteLength: number;
  sha256: string;
  bytes: Buffer;
  manifest: FirmwareManifest;
}

export interface FirmwareInboxAccessControl {
  protectAndVerify(directory: string, files: readonly string[]): Promise<void>;
}

export class FirmwareInboxError extends Error {
  constructor(message: string) { super(message); this.name = "FirmwareInboxError"; }
}

export function getFirmwareInboxDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    const localAppData = environment["LOCALAPPDATA"];
    if (!localAppData) throw new FirmwareInboxError("The protected Windows firmware inbox is unavailable for this user.");
    return join(localAppData, "NeonByte", "firmware-inbox");
  }
  const dataHome = environment["XDG_DATA_HOME"] || join(homedir(), ".local", "share");
  return join(dataHome, "NeonByte", "firmware-inbox");
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && /^[A-Za-z0-9._:-]+$/.test(value);
}

function validManifest(value: unknown): value is FirmwareManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const target = item["target"] as Record<string, unknown> | undefined;
  const regions = item["linkedRegions"] as Record<string, unknown> | undefined;
  const gates = item["featureGates"] as Record<string, unknown> | undefined;
  const resources = item["minimumResources"] as Record<string, unknown> | undefined;
  const validation = item["validation"] as Record<string, unknown> | undefined;
  const exactKeys = ["schemaVersion", "fileName", "byteLength", "sha256", "imageFormat", "firmwareVersion", "buildId", "deviceId", "profile",
    "recoveryIdentityFingerprint", "sourceRevision", "target", "linkedRegions", "featureGates", "minimumResources", "validation"];
  if (Object.keys(item).length !== exactKeys.length || !exactKeys.every((key) => Object.hasOwn(item, key)) ||
      item["schemaVersion"] !== 1 || item["fileName"] !== "firmware.bin" ||
      !Number.isSafeInteger(item["byteLength"]) || Number(item["byteLength"]) < 0x1021 || Number(item["byteLength"]) > MAX_PREPARATION_FIRMWARE_BYTES ||
      !/^[a-f0-9]{64}$/.test(String(item["sha256"])) || item["imageFormat"] !== "esp8266-combined-e9" ||
      !validText(item["firmwareVersion"], 64) || !validText(item["buildId"], 96) || !validText(item["deviceId"], 64) ||
      !validText(item["profile"], 96) || !/^[a-f0-9]{64}$/.test(String(item["recoveryIdentityFingerprint"])) ||
      !/^[a-f0-9]{40}$/.test(String(item["sourceRevision"]))) return false;
  if (!target || Object.keys(target).length !== 4 || target["family"] !== "esp8266" || target["flashMode"] !== "dio" ||
      target["flashFrequencyMHz"] !== 40 || target["flashBytes"] !== 4_194_304) return false;
  if (!regions || Object.keys(regions).length !== 5 || regions["bootloaderStart"] !== 0 || regions["applicationStart"] !== 4096 ||
      !Number.isSafeInteger(regions["filesystemStart"]) || Number(regions["filesystemStart"]) <= 4096 ||
      !Number.isSafeInteger(regions["filesystemEnd"]) || Number(regions["filesystemEnd"]) <= Number(regions["filesystemStart"]) ||
      !Number.isSafeInteger(regions["eepromStart"]) || Number(regions["eepromStart"]) < Number(regions["filesystemEnd"]) || Number(regions["eepromStart"]) > 4_194_304) return false;
  if (!gates || Object.keys(gates).length !== 2 || typeof gates["maintenanceOnBoot"] !== "boolean" || typeof gates["otaEnabled"] !== "boolean") return false;
  if (!resources || Object.keys(resources).length !== 2 || !Number.isSafeInteger(resources["minimumFreeHeapBytes"]) ||
      Number(resources["minimumFreeHeapBytes"]) <= 0 || !Number.isSafeInteger(resources["minimumLargestBlockBytes"]) ||
      Number(resources["minimumLargestBlockBytes"]) <= 0) return false;
  return Boolean(validation && Object.keys(validation).length === 4 && validation["combinedImage"] === true &&
      validation["modernCrc"] === true && validation["runtimeBounds"] === true && validation["recoveryIdentity"] === true);
}

function validateImageHeader(bytes: Buffer): boolean {
  if (bytes.length <= 0x1020) return false;
  for (const offset of [0, 0x1000]) {
    const magic = bytes[offset];
    const segments = bytes[offset + 1];
    const mode = bytes[offset + 2];
    const frequencyAndSize = bytes[offset + 3];
    if (magic !== 0xe9 || segments === undefined || segments < 1 || segments > 16 || mode !== 2 || frequencyAndSize !== 0x40) return false;
  }
  return true;
}

function equalFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function readStableFile(path: string, maximumBytes: number): Promise<Buffer> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(path, constants.O_RDONLY | noFollow); }
  catch { throw new FirmwareInboxError("A firmware inbox file is missing, redirected, or unavailable."); }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) {
      throw new FirmwareInboxError("A firmware inbox file is incomplete, changing, or exceeds its local size limit.");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maximumBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(FILE_READ_CHUNK_BYTES, maximumBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maximumBytes) throw new FirmwareInboxError("A firmware inbox file exceeds its local size limit.");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const currentPath = await lstat(path, { bigint: true });
    if (!equalFileIdentity(before, after) || !equalFileIdentity(after, currentPath) || total !== Number(after.size)) {
      throw new FirmwareInboxError("A firmware inbox file changed while it was being read.");
    }
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}

async function protectPosixInbox(directory: string, files: readonly string[]): Promise<void> {
  try {
    const directoryStat = await lstat(directory);
    const resolved = await realpath(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || resolve(resolved) !== resolve(directory) ||
        (typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) || (directoryStat.mode & 0o077) !== 0) {
      throw new Error();
    }
    for (const path of files) {
      const value = await lstat(path);
      if (!value.isFile() || value.isSymbolicLink() || (typeof process.getuid === "function" && value.uid !== process.getuid()) || (value.mode & 0o077) !== 0) throw new Error();
    }
  } catch { throw new FirmwareInboxError("The firmware inbox permissions are too broad or the files are redirected."); }
}

async function protectWindowsInbox(directory: string, files: readonly string[]): Promise<void> {
  const audit = [
    "$ErrorActionPreference = 'Stop'",
    "$allowed = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')",
    "$paths = @($env:NEONBYTE_INBOX_DIRECTORY)",
    "if ($env:NEONBYTE_INBOX_FILES) { $paths += @($env:NEONBYTE_INBOX_FILES -split [char]31) }",
    "foreach ($path in $paths) { $acl = Get-Acl -LiteralPath $path; foreach ($rule in $acl.Access) {",
    "$sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;",
    "if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and $allowed -notcontains $sid) { exit 23 } } }",
    "exit 0",
  ].join(" ");
  try {
    await execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", audit], {
      windowsHide: true, timeout: 5_000, env: { ...process.env, NEONBYTE_INBOX_DIRECTORY: directory, NEONBYTE_INBOX_FILES: files.join(String.fromCharCode(31)) },
    });
  } catch { throw new FirmwareInboxError("The firmware inbox ACL is not restricted to this user and required Windows principals."); }
}

async function defaultAccessControl(directory: string, files: readonly string[]): Promise<void> {
  if (process.platform === "win32") return protectWindowsInbox(directory, files);
  return protectPosixInbox(directory, files);
}

export async function verifyLocalProtectedAccess(directory: string, files: readonly string[]): Promise<void> {
  return defaultAccessControl(directory, files);
}

export class FirmwareInbox {
  private readonly directory: string;
  private readonly accessControl: FirmwareInboxAccessControl;

  constructor(options: { directory?: string; accessControl?: FirmwareInboxAccessControl } = {}) {
    this.directory = resolve(options.directory ?? getFirmwareInboxDirectory());
    this.accessControl = options.accessControl ?? { protectAndVerify: defaultAccessControl };
  }

  async prepare(binding: Pick<RecoveryCredential, "deviceId" | "profile" | "recoveryIdentityFingerprint">): Promise<PreparedFirmwareCandidate> {
    try { await mkdir(this.directory, { recursive: true, mode: 0o700 }); }
    catch { throw new FirmwareInboxError("The protected firmware inbox is unavailable for this user."); }
    let directoryInfo;
    let names: string[];
    try { directoryInfo = await lstat(this.directory); names = await readdir(this.directory); }
    catch { throw new FirmwareInboxError("The protected firmware inbox is unavailable for this user."); }
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new FirmwareInboxError("The firmware inbox path is redirected.");
    if (names.length !== 2 || !names.includes("firmware.bin") || !names.includes("manifest.json")) {
      if (!names.includes("firmware.bin") || !names.includes("manifest.json")) throw new FirmwareInboxError("The protected firmware pair is incomplete.");
      throw new FirmwareInboxError("The firmware inbox may contain only firmware.bin and manifest.json.");
    }
    const firmwarePath = join(this.directory, "firmware.bin");
    const manifestPath = join(this.directory, "manifest.json");
    for (const path of [firmwarePath, manifestPath]) {
      const value = await lstat(path);
      if (!value.isFile() || value.isSymbolicLink()) throw new FirmwareInboxError("The firmware inbox path is redirected.");
    }
    await this.accessControl.protectAndVerify(this.directory, [firmwarePath, manifestPath]);
    const [bytes, manifestBytes] = await Promise.all([
      readStableFile(firmwarePath, MAX_PREPARATION_FIRMWARE_BYTES),
      readStableFile(manifestPath, MANIFEST_LIMIT_BYTES),
    ]);
    let parsed: unknown;
    try { parsed = JSON.parse(manifestBytes.toString("utf8")) as unknown; }
    catch { throw new FirmwareInboxError("The firmware manifest is invalid."); }
    if (!validManifest(parsed)) throw new FirmwareInboxError("The firmware manifest is invalid or does not describe a verified private build.");
    if (parsed.byteLength !== bytes.length) throw new FirmwareInboxError("The firmware length does not match its trusted manifest.");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (parsed.sha256 !== digest) throw new FirmwareInboxError("The firmware SHA-256 does not match its trusted manifest.");
    if (parsed.deviceId !== binding.deviceId) throw new FirmwareInboxError("The manifest device identity does not match the enrolled recovery record.");
    if (parsed.profile !== binding.profile) throw new FirmwareInboxError("The manifest firmware profile does not match the enrolled device.");
    if (parsed.recoveryIdentityFingerprint !== binding.recoveryIdentityFingerprint) throw new FirmwareInboxError("The manifest recovery identity does not match the enrolled recovery record.");
    if (!parsed.featureGates.maintenanceOnBoot || !parsed.featureGates.otaEnabled) throw new FirmwareInboxError("The firmware manifest feature gates do not permit maintenance OTA.");
    if (!validateImageHeader(bytes)) throw new FirmwareInboxError("The image must use the supported combined DIO 40 MHz ESP8266 format.");

    return { id: randomUUID(), fileName: "firmware.bin", byteLength: bytes.length, sha256: digest,
      bytes: Buffer.from(bytes), manifest: structuredClone(parsed) };
  }
}
