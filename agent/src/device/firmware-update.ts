import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { rename, mkdir, open, lstat, unlink, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { MAINTENANCE_HTTP_TIMEOUT_MS, MaintenanceRequestError, MaintenanceTransportError, type MaintenanceClient, type MaintenanceDiagnostics, type MaintenanceInfo, type MaintenanceStatus, validateMaintenanceOrigin } from "./maintenance-client.js";
import { FirmwareInbox, isDeferredRuntimeBounds, verifyLocalProtectedAccess, type PreparedFirmwareCandidate, type RuntimeBoundsValidation } from "./firmware-inbox.js";
import type { RecoveryCredential, RecoveryCredentialStore } from "./recovery-store.js";

export type FirmwareUpdateState = "idle" | "preparing" | "ready" | "preflight" | "pausing" | "uploading" |
  "waitingForReboot" | "reconnecting" | "verifying" | "verified" | "experimentallyVerified" | "rejected" | "transferFailed" |
  "verificationFailed" | "outcomeUnknown" | "started" | "reconciling" | "manuallyReconciled";
export type FirmwareUpdatePurpose = "production" | "experimental-test";

export interface ManualReconciliationEvidence {
  bootId: string;
  observations: 2;
  intervalMs: number;
  firstFreeHeapBytes: number;
  firstLargestBlockBytes: number;
  secondFreeHeapBytes: number;
  secondLargestBlockBytes: number;
}

export type FirmwareUpdateHistoryEntry = Omit<FirmwareUpdateRecord, "history">;

export interface FirmwareUpdateRecord {
  version: 1;
  state: FirmwareUpdateState;
  purpose?: FirmwareUpdatePurpose;
  putAttempted: boolean;
  deviceId: string;
  profile: string;
  recoveryIdentityFingerprint: string;
  previousBuildId: string;
  expectedBuildId: string;
  expectedBootId: string;
  verifiedBootId?: string;
  sourceRevision?: string;
  runtimeBounds?: RuntimeBoundsValidation;
  sha256: string;
  byteLength: number;
  minimumFreeHeapBytes: number | null;
  minimumLargestBlockBytes: number | null;
  previousAddress: string;
  manualReconciliation?: ManualReconciliationEvidence;
  history?: FirmwareUpdateHistoryEntry[];
}

export interface FirmwareUpdateJournal {
  load(): Promise<FirmwareUpdateRecord | null>;
  save(value: FirmwareUpdateRecord): Promise<void>;
  archive?(entries: FirmwareUpdateHistoryEntry[]): Promise<void>;
}

export class SystemFirmwareUpdateJournal implements FirmwareUpdateJournal {
  private readonly directory: string;
  private readonly path: string;
  constructor(path = defaultJournalPath()) { this.path = resolve(path); this.directory = dirname(this.path); }

  async load(): Promise<FirmwareUpdateRecord | null> {
    let pathInfo;
    try { pathInfo = await lstat(this.path, { bigint: true }); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw new Error("The protected firmware update journal is unavailable.");
    }
    try {
      if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) throw new Error();
      await verifyLocalProtectedAccess(this.directory, [this.path]);
      const handle = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let serialized: string;
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.dev !== pathInfo.dev || before.ino !== pathInfo.ino || before.size > 16_384n) throw new Error();
        serialized = await handle.readFile("utf8");
        const after = await handle.stat({ bigint: true });
        const pathAfter = await lstat(this.path, { bigint: true });
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs ||
            after.ctimeNs !== before.ctimeNs || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.isSymbolicLink()) throw new Error();
      } finally { await handle.close(); }
      const parsed: unknown = JSON.parse(serialized);
      if (!validRecord(parsed)) throw new Error();
      return parsed;
    } catch { throw new Error("The protected firmware update journal is invalid or has unsafe permissions."); }
  }

  async save(value: FirmwareUpdateRecord): Promise<void> {
    if (!validRecord(value)) throw new Error("The firmware update journal record is invalid.");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { await verifyLocalProtectedAccess(this.directory, []); }
    catch { throw new Error("The firmware update journal permissions are too broad."); }
    const temporaryPath = join(this.directory, `.update-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(value), "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await verifyLocalProtectedAccess(this.directory, [temporaryPath]);
      await rename(temporaryPath, this.path);
      await verifyLocalProtectedAccess(this.directory, [this.path]);
    } catch {
      try { await unlink(temporaryPath); } catch { /* The fixed journal remains protected and is revalidated before use. */ }
      throw new Error("Unable to save the protected firmware update journal.");
    }
  }

  async archive(entries: FirmwareUpdateHistoryEntry[]): Promise<void> {
    if (entries.length !== 1 || !entries.every((entry) => validRecord(entry, false))) throw new Error("The protected update history is invalid.");
    try {
      await verifyLocalProtectedAccess(this.directory, [this.path]);
      const archiveDirectory = join(this.directory, `firmware-update-history-${randomUUID()}`);
      await mkdir(archiveDirectory, { mode: 0o700 });
      await verifyLocalProtectedAccess(archiveDirectory, []);
      const temporaryPath = join(archiveDirectory, `.history-${randomUUID()}.tmp`);
      const finalPath = join(archiveDirectory, "history.json");
      const serialized = JSON.stringify({ version: 1, entries });
      const handle = await open(temporaryPath, "wx", 0o600);
      try { await handle.writeFile(serialized, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await verifyLocalProtectedAccess(archiveDirectory, [temporaryPath]);
      await rename(temporaryPath, finalPath);
      if (process.platform !== "win32") {
        for (const path of [archiveDirectory, this.directory]) {
          const directoryHandle = await open(path, "r");
          try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
        }
      }
      const recovered = await this.readArchive(archiveDirectory);
      if (JSON.stringify(recovered) !== JSON.stringify(entries)) throw new Error();
    } catch { throw new Error("The protected update history could not be archived safely."); }
  }

  async listArchived(): Promise<FirmwareUpdateHistoryEntry[]> {
    await verifyLocalProtectedAccess(this.directory, []);
    const names = (await readdir(this.directory)).filter((name) => /^firmware-update-history-[0-9a-f-]{36}$/.test(name)).sort();
    const entries: FirmwareUpdateHistoryEntry[] = [];
    for (const name of names) {
      const directory = join(this.directory, name);
      await verifyLocalProtectedAccess(directory, []);
      // An interrupted write leaves the original journal intact; incomplete archives contain no committed entries.
      try { await lstat(join(directory, "history.json")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      entries.push(...await this.readArchive(directory));
    }
    return entries;
  }

  private async readArchive(directory: string): Promise<FirmwareUpdateHistoryEntry[]> {
    const path = join(directory, "history.json");
    const beforePath = await lstat(path, { bigint: true });
    await verifyLocalProtectedAccess(this.directory, []);
    await verifyLocalProtectedAccess(directory, [path]);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.dev !== beforePath.dev || before.ino !== beforePath.ino || before.size > 16_384n) throw new Error();
      const serialized = await handle.readFile("utf8");
      const after = await handle.stat({ bigint: true });
      const pathAfter = await lstat(path, { bigint: true });
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs ||
          after.ctimeNs !== before.ctimeNs || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.isSymbolicLink()) throw new Error();
      const parsed: unknown = JSON.parse(serialized);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      const value = parsed as Record<string, unknown>;
      if (Object.keys(value).length !== 2 || value["version"] !== 1 || !Array.isArray(value["entries"]) ||
          value["entries"].length !== 1 || !value["entries"].every((entry: unknown) => validRecord(entry, false))) throw new Error();
      return value["entries"] as FirmwareUpdateHistoryEntry[];
    } finally { await handle.close(); }
  }
}

function defaultJournalPath(): string {
  if (process.platform === "win32") {
    const localAppData = process.env["LOCALAPPDATA"];
    if (!localAppData) throw new Error("The protected firmware update journal is unavailable for this user.");
    return join(localAppData, "NeonByte", "firmware-update.json");
  }
  return join(process.env["XDG_DATA_HOME"] || join(process.env["HOME"] || ".", ".local", "share"), "NeonByte", "firmware-update.json");
}

const validStates = new Set<FirmwareUpdateState>(["idle", "preparing", "ready", "preflight", "pausing", "uploading",
  "waitingForReboot", "reconnecting", "verifying", "verified", "experimentallyVerified", "rejected", "transferFailed", "verificationFailed", "outcomeUnknown", "started", "reconciling", "manuallyReconciled"]);

function recordPurpose(record: Pick<FirmwareUpdateRecord, "purpose">): FirmwareUpdatePurpose {
  return record.purpose ?? "production";
}

function candidatePurpose(candidate: PreparedFirmwareCandidate): FirmwareUpdatePurpose {
  return candidate.manifest.purpose ?? "production";
}

function meetsResourceFloors(diagnostics: MaintenanceDiagnostics, record: Pick<FirmwareUpdateRecord, "minimumFreeHeapBytes" | "minimumLargestBlockBytes">): boolean {
  return record.minimumFreeHeapBytes === null || record.minimumLargestBlockBytes === null ||
    (diagnostics.freeHeapBytes >= record.minimumFreeHeapBytes && diagnostics.maxFreeBlockBytes >= record.minimumLargestBlockBytes);
}

function validRecord(value: unknown, allowHistory = true): value is FirmwareUpdateRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = ["version", "state", "putAttempted", "deviceId", "profile", "recoveryIdentityFingerprint", "previousBuildId", "expectedBuildId", "expectedBootId",
    "sha256", "byteLength", "minimumFreeHeapBytes", "minimumLargestBlockBytes", "previousAddress"];
  const presentKeys = Object.keys(item);
  if (!presentKeys.every((key) => keys.includes(key) || ["purpose", "sourceRevision", "runtimeBounds", "verifiedBootId", "history", "manualReconciliation"].includes(key)) || !keys.every((key) => Object.hasOwn(item, key)) || item["version"] !== 1 ||
      typeof item["state"] !== "string" || !validStates.has(item["state"] as FirmwareUpdateState) || typeof item["putAttempted"] !== "boolean" ||
      (Object.hasOwn(item, "purpose") && item["purpose"] !== "production" && item["purpose"] !== "experimental-test") ||
      typeof item["deviceId"] !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(item["deviceId"]) ||
      typeof item["profile"] !== "string" || !/^[A-Za-z0-9._:-]{1,96}$/.test(item["profile"]) ||
      typeof item["recoveryIdentityFingerprint"] !== "string" || !/^[a-f0-9]{64}$/.test(item["recoveryIdentityFingerprint"]) ||
      typeof item["previousBuildId"] !== "string" || !/^[A-Za-z0-9._:-]{1,96}$/.test(item["previousBuildId"]) ||
      typeof item["expectedBuildId"] !== "string" || !/^[A-Za-z0-9._:-]{1,96}$/.test(item["expectedBuildId"]) ||
      typeof item["expectedBootId"] !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(item["expectedBootId"]) ||
      (Object.hasOwn(item, "verifiedBootId") && (typeof item["verifiedBootId"] !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(item["verifiedBootId"]))) ||
      (Object.hasOwn(item, "sourceRevision") && (typeof item["sourceRevision"] !== "string" || !/^[a-f0-9]{40}$/.test(item["sourceRevision"]))) ||
      (Object.hasOwn(item, "runtimeBounds") && item["runtimeBounds"] !== true &&
        !(isDeferredRuntimeBounds(item["runtimeBounds"]) && item["runtimeBounds"].requiredBuildId === item["previousBuildId"] && recordPurpose(item as Pick<FirmwareUpdateRecord, "purpose">) === "experimental-test")) ||
      typeof item["sha256"] !== "string" || !/^[a-f0-9]{64}$/.test(item["sha256"]) ||
      !Number.isSafeInteger(item["byteLength"]) || Number(item["byteLength"]) < 1 || Number(item["byteLength"]) > 458_752 ||
      (recordPurpose(item as Pick<FirmwareUpdateRecord, "purpose">) === "production" &&
        (!Number.isSafeInteger(item["minimumFreeHeapBytes"]) || Number(item["minimumFreeHeapBytes"]) < 1 ||
         !Number.isSafeInteger(item["minimumLargestBlockBytes"]) || Number(item["minimumLargestBlockBytes"]) < 1)) ||
      (recordPurpose(item as Pick<FirmwareUpdateRecord, "purpose">) === "experimental-test" &&
        !((item["minimumFreeHeapBytes"] === null && item["minimumLargestBlockBytes"] === null) ||
          (Number.isSafeInteger(item["minimumFreeHeapBytes"]) && Number(item["minimumFreeHeapBytes"]) > 0 &&
           Number.isSafeInteger(item["minimumLargestBlockBytes"]) && Number(item["minimumLargestBlockBytes"]) > 0))) ||
      typeof item["previousAddress"] !== "string") return false;
  if ((item["state"] === "experimentallyVerified" &&
      (recordPurpose(item as Pick<FirmwareUpdateRecord, "purpose">) !== "experimental-test" || !item["putAttempted"] || !item["verifiedBootId"])) ||
      (item["state"] === "verified" && recordPurpose(item as Pick<FirmwareUpdateRecord, "purpose">) === "experimental-test")) return false;
  if (Object.hasOwn(item, "history") && (!allowHistory || !Array.isArray(item["history"]) || item["history"].length > 8 ||
      !item["history"].every((entry: unknown) => validRecord(entry, false)))) return false;
  if (Object.hasOwn(item, "manualReconciliation")) {
    const evidence = item["manualReconciliation"] as Record<string, unknown> | null;
    const evidenceKeys = ["bootId", "observations", "intervalMs", "firstFreeHeapBytes", "firstLargestBlockBytes", "secondFreeHeapBytes", "secondLargestBlockBytes"];
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || Object.keys(evidence).length !== evidenceKeys.length ||
        !evidenceKeys.every((key) => Object.hasOwn(evidence, key)) || typeof evidence["bootId"] !== "string" ||
        !/^[A-Za-z0-9._:-]{1,64}$/.test(evidence["bootId"]) || evidence["observations"] !== 2 ||
        !Number.isSafeInteger(evidence["intervalMs"]) || Number(evidence["intervalMs"]) < 2000 || Number(evidence["intervalMs"]) > 30_000 ||
        !["firstFreeHeapBytes", "firstLargestBlockBytes", "secondFreeHeapBytes", "secondLargestBlockBytes"].every(
          (key) => Number.isSafeInteger(evidence[key]) && Number(evidence[key]) > 0) || evidence["bootId"] === item["expectedBootId"] ||
        (item["minimumFreeHeapBytes"] !== null && (Number(evidence["firstFreeHeapBytes"]) < Number(item["minimumFreeHeapBytes"]) ||
          Number(evidence["secondFreeHeapBytes"]) < Number(item["minimumFreeHeapBytes"]))) ||
        (item["minimumLargestBlockBytes"] !== null && (Number(evidence["firstLargestBlockBytes"]) < Number(item["minimumLargestBlockBytes"]) ||
          Number(evidence["secondLargestBlockBytes"]) < Number(item["minimumLargestBlockBytes"])))) return false;
  }
  if (item["state"] === "manuallyReconciled") {
    if (!item["putAttempted"] || !item["manualReconciliation"]) return false;
    if (allowHistory) {
      const history = item["history"] as FirmwareUpdateHistoryEntry[] | undefined;
      const previous = history?.[history.length - 1];
      if (!previous?.putAttempted || previous.deviceId !== item["deviceId"] || previous.profile !== item["profile"] ||
          previous.recoveryIdentityFingerprint !== item["recoveryIdentityFingerprint"] || previous.previousBuildId !== item["previousBuildId"] ||
          previous.expectedBuildId !== item["expectedBuildId"] || previous.expectedBootId !== item["expectedBootId"] ||
          previous.sha256 !== item["sha256"] || previous.byteLength !== item["byteLength"] ||
          recordPurpose(previous) !== recordPurpose(item as Pick<FirmwareUpdateRecord, "purpose">) ||
          JSON.stringify(previous.runtimeBounds) !== JSON.stringify(item["runtimeBounds"]) ||
          previous.minimumFreeHeapBytes !== item["minimumFreeHeapBytes"] ||
          previous.minimumLargestBlockBytes !== item["minimumLargestBlockBytes"]) return false;
    }
  }
  try { return validateMaintenanceOrigin(item["previousAddress"]).origin === item["previousAddress"]; }
  catch { return false; }
}

interface MaintenanceClientPort extends Pick<MaintenanceClient, "info" | "status" | "diagnostics" | "pause" | "run" | "uploadFirmware"> {}
interface FirmwareInboxPort { prepare(binding: Pick<RecoveryCredential, "deviceId" | "profile" | "recoveryIdentityFingerprint">): Promise<PreparedFirmwareCandidate> }
interface UpdateDeviceControl {
  suspendAndDrain(): Promise<void>;
  holdForMaintenance?(): void;
  resumeAfterSafePreflightAbort(): void;
  resumeAfterExplicitRun(): void;
  resumeAfterManualReconciliation?(): void;
  rebindVerifiedAddress?(address: string, resumeScheduler?: boolean): Promise<void>;
}

export interface FirmwareUpdateView {
  state: FirmwareUpdateState;
  purpose: FirmwareUpdatePurpose | null;
  sourceRevision: string | null;
  runtimeBounds?: RuntimeBoundsValidation | null;
  candidate: null | { id: string; fileName: "firmware.bin"; byteLength: number; sha256: string; expectedBuildId: string;
    deviceId: string; profile: string; purpose: FirmwareUpdatePurpose; sourceRevision: string;
    target: PreparedFirmwareCandidate["manifest"]["target"]; linkedRegions: PreparedFirmwareCandidate["manifest"]["linkedRegions"];
    runtimeBounds?: PreparedFirmwareCandidate["manifest"]["validation"]["runtimeBounds"] };
  bytesSent: number;
  totalBytes: number;
  message: string;
  putAttempted: boolean;
  effectiveAddress: string;
  recoverableAttempt?: { expectedBuildId: string; deviceId: string } | null;
}

const messages: Record<FirmwareUpdateState, string> = {
  idle: "No firmware update is prepared.", preparing: "Checking local firmware and device identity.", ready: "Firmware is ready for explicit confirmation.",
  preflight: "Checking device identity, capacity, and maintenance state.", pausing: "Pausing application synchronization and display work.",
  uploading: "Sending the approved firmware image.", waitingForReboot: "The device accepted the image and is expected to reboot.",
  reconnecting: "Checking the device over its last verified address.", verifying: "Checking firmware identity and maintenance health.",
  verified: "The expected firmware passed two maintenance observations. Start the application when ready.",
  rejected: "Firmware preparation or device validation was rejected. No automatic retry or application startup was requested.",
  transferFailed: "The firmware transfer did not complete. The application remains paused; do not retry automatically.",
  verificationFailed: "The expected firmware could not be verified in maintenance. The device's current state requires authenticated review.",
  outcomeUnknown: "The firmware response was lost. Reconnect and verify; the image will not be sent again.",
  started: "The verified application was started explicitly.",
  reconciling: "Checking the running firmware with two authenticated observations.",
  manuallyReconciled: "A running firmware was manually reconciled from two authenticated observations; the previous OTA was not marked verified.",
  experimentallyVerified: "The experimental build identity and maintenance boot were observed twice. Production acceptance remains pending.",
};

export class FirmwareUpdateService {
  private state: FirmwareUpdateState = "idle";
  private candidate: PreparedFirmwareCandidate | null = null;
  private record: FirmwareUpdateRecord | null = null;
  private active = false;
  private restoration: Promise<void> | null = null;
  private bytesSent = 0;
  private effectiveAddress = "";
  private candidatePreparedAt = 0;
  private journalUnavailable = false;
  private detailMessage: string | null = null;

  constructor(private readonly options: {
    recoveryStore: RecoveryCredentialStore;
    inbox?: FirmwareInboxPort;
    journal: FirmwareUpdateJournal;
    createClient(address: string, token: string): MaintenanceClientPort;
    device: UpdateDeviceControl;
    now?: () => number;
    wait?: (milliseconds: number) => Promise<void>;
    reconnectWindowMs?: number;
    candidateTtlMs?: number;
  }) {}

  get view(): FirmwareUpdateView {
    const record = this.record;
    const purpose = this.candidate ? candidatePurpose(this.candidate) : record ? recordPurpose(record) : null;
    const baseMessage = this.detailMessage ?? messages[this.state];
    const message = this.journalUnavailable ? "The protected update journal is unavailable. Firmware will not be sent or replayed." :
      this.detailMessage ?? (purpose === "experimental-test" ? this.experimentalMessage() : baseMessage);
    return { state: this.state,
      candidate: this.candidate ? { id: this.candidate.id, fileName: this.candidate.fileName, byteLength: this.candidate.byteLength,
        sha256: this.candidate.sha256, expectedBuildId: this.candidate.manifest.buildId, deviceId: this.candidate.manifest.deviceId,
        profile: this.candidate.manifest.profile, purpose: candidatePurpose(this.candidate), sourceRevision: this.candidate.manifest.sourceRevision,
        target: this.candidate.manifest.target, linkedRegions: this.candidate.manifest.linkedRegions,
        runtimeBounds: this.candidate.manifest.validation.runtimeBounds } : null,
      purpose, sourceRevision: this.candidate?.manifest.sourceRevision ?? record?.sourceRevision ?? null,
      runtimeBounds: this.candidate?.manifest.validation.runtimeBounds ?? record?.runtimeBounds ?? null,
      bytesSent: this.bytesSent, totalBytes: this.candidate?.byteLength ?? record?.byteLength ?? 0,
      message,
      putAttempted: record?.putAttempted ?? false, effectiveAddress: this.effectiveAddress || record?.previousAddress || "",
      recoverableAttempt: record?.putAttempted && ["outcomeUnknown", "verificationFailed", "waitingForReboot", "rejected"].includes(this.state) &&
        !["rejected", "transferFailed"].includes(record.state)
        ? { expectedBuildId: record.expectedBuildId, deviceId: record.deviceId } : null };
  }

  private experimentalMessage(): string {
    switch (this.state) {
      case "ready": return "Experimental test candidate is ready for explicit one-time confirmation. Production approval remains pending.";
      case "experimentallyVerified": return "Experimental build identity and maintenance state passed two observations. Resource floors and production approval remain pending.";
      case "started": return "The experimental application was started explicitly. Hardware homologation and production acceptance remain pending.";
      default: return `${messages[this.state]} This is an experimental test; production acceptance remains pending.`;
    }
  }

  async getStatus(): Promise<FirmwareUpdateView> {
    await this.restore();
    if (!this.effectiveAddress && !this.record?.previousAddress) {
      try { this.effectiveAddress = (await this.options.recoveryStore.get())?.lastVerifiedAddress ?? ""; }
      catch { this.effectiveAddress = ""; }
    }
    return this.view;
  }

  async restore(): Promise<void> {
    if (!this.restoration) this.restoration = this.restoreJournal();
    await this.restoration;
  }

  private async restoreJournal(): Promise<void> {
    let record: FirmwareUpdateRecord | null;
    try { record = await this.options.journal.load(); }
    catch {
      this.journalUnavailable = true;
      this.state = "outcomeUnknown";
      this.options.device.holdForMaintenance?.();
      return;
    }
    if (!record) return;
    this.record = record;
    if (record.putAttempted && !["started", "manuallyReconciled"].includes(record.state)) {
      this.options.device.holdForMaintenance?.();
      if (record.state === "verified" && record.verifiedBootId) this.state = "verified";
      else if (record.state === "experimentallyVerified" && record.verifiedBootId) this.state = "experimentallyVerified";
      else if (record.state === "verificationFailed") this.state = "verificationFailed";
      else this.state = "outcomeUnknown";
    } else if (record.state === "verified") this.state = "verified";
    else if (record.state === "started") this.state = "started";
    else if (record.state === "manuallyReconciled") this.state = "manuallyReconciled";
    else this.state = "idle";
  }

  async prepare(): Promise<FirmwareUpdateView> {
    await this.restore();
    if (!this.enter()) throw new Error("A firmware update operation is already in progress.");
    if (this.journalUnavailable) { this.leave(); throw new Error("The protected firmware update journal is unavailable."); }
    if (this.record?.putAttempted && !["started", "manuallyReconciled"].includes(this.state)) {
      this.leave();
      throw new Error("Verify, explicitly start, or manually reconcile the previous firmware before preparing another update.");
    }
    let previousRecord = this.record;
    try {
      this.candidate = null; this.candidatePreparedAt = 0; this.bytesSent = 0; this.state = "preparing";
      this.detailMessage = null;
      const credential = await this.requiredCredential();
      const invalidateReconciliation = async (): Promise<never> => {
        if (!previousRecord || previousRecord.state !== "manuallyReconciled") throw new Error("No reconciliation is available.");
        const history = await archiveAttempt(previousRecord, this.options.journal);
        await this.options.device.suspendAndDrain();
        previousRecord = { ...previousRecord, state: "verificationFailed", history };
        this.record = previousRecord;
        await this.persist();
        throw new Error("The reconciled device changed; reconcile the running firmware again before preparing another update.");
      };
      if (previousRecord?.state === "manuallyReconciled" && !sameBinding(previousRecord, credential)) await invalidateReconciliation();
      this.effectiveAddress = credential.lastVerifiedAddress;
      const candidate = await (this.options.inbox ?? new FirmwareInbox()).prepare(credential);
      if (isDeferredRuntimeBounds(candidate.manifest.validation.runtimeBounds) && candidatePurpose(candidate) !== "experimental-test") {
        throw new Error("Deferred geometry is allowed only for experimental tests.");
      }
      const info = await this.options.createClient(credential.lastVerifiedAddress, credential.token).info();
      if (previousRecord?.state === "manuallyReconciled" &&
          (info.deviceId !== previousRecord.deviceId || info.profile !== previousRecord.profile ||
           info.recoveryIdentityFingerprint !== previousRecord.recoveryIdentityFingerprint || info.buildId !== previousRecord.expectedBuildId ||
           info.bootId !== previousRecord.manualReconciliation?.bootId)) {
        await invalidateReconciliation();
      }
      this.assertBoundInfo(info, credential);
      this.assertCapacity(info, candidate);
      this.candidate = candidate;
      const history = previousRecord?.putAttempted ? await archiveAttempt(previousRecord, this.options.journal) : previousRecord?.history;
      this.record = { ...this.recordFor(candidate, credential, info, "ready", false), ...(history ? { history } : {}) };
      this.candidatePreparedAt = this.now();
      await this.persist();
      this.state = "ready";
      return this.view;
    } catch (error) {
      this.candidate = null; this.record = previousRecord;
      this.state = previousRecord && ["started", "manuallyReconciled"].includes(previousRecord.state) ? previousRecord.state : "rejected";
      const safeError = safeUpdateError(error, "Firmware preparation failed. Verify the local manifest and enrolled device identity.");
      this.detailMessage = safeError.message;
      throw safeError;
    } finally { this.leave(); }
  }

  async confirm(candidateId: string, experimentalTestConfirmed = false, deviceGeometryConfirmed = false): Promise<FirmwareUpdateView> {
    await this.restore();
    if (!this.enter()) throw new Error("A firmware update operation is already in progress.");
    if (this.journalUnavailable) { this.leave(); throw new Error("The protected firmware update journal is unavailable."); }
    let safeSchedulerResume = false;
    try {
      const candidate = this.candidate;
      if (!candidate || this.state !== "ready" || candidate.id !== candidateId) throw new Error("Prepare firmware again before confirming this update.");
      if (candidatePurpose(candidate) === "experimental-test" && !experimentalTestConfirmed) {
        throw new Error("Explicit experimental authorization is required before sending this firmware.");
      }
      if (isDeferredRuntimeBounds(candidate.manifest.validation.runtimeBounds) && !deviceGeometryConfirmed) {
        throw new Error("Deferred device geometry confirmation is required before sending this firmware.");
      }
      if (this.now() - this.candidatePreparedAt > (this.options.candidateTtlMs ?? 5 * 60_000)) {
        this.candidate = null;
        this.candidatePreparedAt = 0;
        this.state = "idle";
        throw new Error("Prepare firmware again before confirming this update.");
      }
      const credential = await this.requiredCredential();
      this.detailMessage = null;
      this.effectiveAddress = credential.lastVerifiedAddress;
      this.state = "preflight";
      let client = this.options.createClient(credential.lastVerifiedAddress, credential.token);
      const info = await client.info();
      const status = await client.status();
      const diagnostics = await client.diagnostics();
      this.assertBoundInfo(info, credential); this.assertCapacity(info, candidate);
      this.assertPreflight(info, status, diagnostics, candidate);

      this.state = "pausing";
      await this.options.device.suspendAndDrain();
      client = this.options.createClient(credential.lastVerifiedAddress, credential.token);
      const postDrainInfo = await client.info();
      this.assertBoundInfo(postDrainInfo, credential); this.assertCapacity(postDrainInfo, candidate);
      if (postDrainInfo.bootId !== info.bootId || postDrainInfo.buildId !== info.buildId) {
        throw new Error("The device rebooted or changed build during preflight; prepare and review the candidate again.");
      }
      const postDrainStatus = await client.status();
      safeSchedulerResume = postDrainStatus.applicationRunning;
      const postDrainDiagnostics = await client.diagnostics();
      this.assertPreflight(postDrainInfo, postDrainStatus, postDrainDiagnostics, candidate);
      if (postDrainStatus.applicationRunning) {
        safeSchedulerResume = false;
        await client.pause();
        if ((await client.status()).applicationRunning) throw new Error("The application did not pause; no firmware was sent.");
      }

      this.record = this.recordFor(candidate, credential, postDrainInfo, "uploading", true);
      await this.persist();
      this.state = "uploading";
      this.bytesSent = 0;
      try {
        await client.uploadFirmware(candidate.bytes, candidate.sha256, (sent) => { this.bytesSent = sent; });
      } catch (error) {
        this.candidate = null;
        if (error instanceof MaintenanceRequestError) {
          this.state = error.code === "invalid_firmware" || error.code === "unsupported_firmware" ? "rejected" : "transferFailed";
          this.detailMessage = error.message;
        } else {
          this.state = "outcomeUnknown";
          this.detailMessage = null;
        }
        this.record = { ...this.record, state: this.state };
        try { await this.persist(); } catch { /* The pre-PUT intent already records that this approval was consumed. */ }
        return this.view;
      }
      this.candidate = null;
      this.candidatePreparedAt = 0;
      this.state = "waitingForReboot";
      this.detailMessage = null;
      this.record = { ...this.record, state: this.state };
      try { await this.persist(); } catch {
        this.state = "outcomeUnknown";
        this.record = { ...this.record, state: "outcomeUnknown" };
      }
      return this.view;
    } catch (error) {
      if (this.record?.putAttempted) {
        this.state = "outcomeUnknown";
        this.candidate = null;
        this.candidatePreparedAt = 0;
        this.record = { ...this.record, state: "outcomeUnknown" };
        try { await this.persist(); } catch { /* Keep the in-memory job non-replayable. */ }
      } else {
        if (safeSchedulerResume) {
          try { this.options.device.resumeAfterSafePreflightAbort(); } catch { /* Keep OTA blocked if the scheduler cannot be restored safely. */ }
        }
        if (this.state !== "ready" && this.state !== "idle") {
          this.state = "rejected";
          this.candidate = null;
          this.candidatePreparedAt = 0;
        }
      }
      const safeError = safeUpdateError(error, "Preflight failed. No automatic firmware retry or application restart was attempted.");
      this.detailMessage = safeError.message;
      throw safeError;
    } finally { this.leave(); }
  }

  async verify(): Promise<FirmwareUpdateView> {
    await this.restore();
    if (!this.enter()) throw new Error("A firmware update operation is already in progress.");
    if (this.journalUnavailable) { this.leave(); throw new Error("The protected firmware update journal is unavailable."); }
    try {
      const record = this.record;
      if (record && ["rejected", "transferFailed"].includes(record.state)) {
        throw new Error("The previous firmware transfer failed or was rejected; it cannot be verified automatically.");
      }
      if (!record?.putAttempted || !["waitingForReboot", "outcomeUnknown", "reconnecting", "verifying", "verificationFailed"].includes(this.state)) {
        throw new Error("There is no attempted firmware update to verify.");
      }
      const credential = await this.requiredCredential();
      this.effectiveAddress = credential.lastVerifiedAddress;
      if (!sameBinding(record, credential)) throw new Error("The enrolled recovery identity changed; this update cannot be reconciled.");
      const startedAt = this.now();
      const deadline = startedAt + (this.options.reconnectWindowMs ?? 120_000);
      let attempts = 0;
      let delay = 2_000;
      let firstObservationAt: number | null = null;
      let firstObservationBootId: string | null = null;
      let sawAuthenticatedDevice = false;
      let sawExpectedRunning = false;
      this.state = "reconnecting";
      this.detailMessage = null;
      const requestTimeoutMs = (): number => {
        const remaining = deadline - this.now();
        if (remaining <= 0) throw new Error("The verification window expired.");
        return Math.max(1, Math.min(MAINTENANCE_HTTP_TIMEOUT_MS, Math.ceil(remaining)));
      };
      while (attempts < 60 && this.now() < deadline) {
        attempts++;
        try {
          const client = this.options.createClient(record.previousAddress, credential.token);
          const info = await client.info(requestTimeoutMs());
          if (info.deviceId !== record.deviceId || info.profile !== record.profile ||
              info.recoveryIdentityFingerprint !== record.recoveryIdentityFingerprint) {
            throw new Error("The responding device does not match the enrolled recovery identity.");
          }
          sawAuthenticatedDevice = true;
          const status = await client.status(requestTimeoutMs());
          const diagnostics = await client.diagnostics(requestTimeoutMs());
          const observation = { info, status, diagnostics };
          if (this.validPostBootIdentity(info, record) && status.applicationRunning) {
            sawExpectedRunning = true;
            break;
          }
          if (this.validPostBootObservation(observation, record)) {
            if (firstObservationAt === null) {
              firstObservationAt = this.now();
              firstObservationBootId = info.bootId;
              this.state = "verifying";
              await this.wait(Math.min(2_000, Math.max(0, deadline - this.now())));
            } else if (info.bootId === firstObservationBootId && this.now() - firstObservationAt >= 2_000 && this.now() < deadline) {
              const verifiedState = recordPurpose(record) === "experimental-test" ? "experimentallyVerified" : "verified";
              this.state = verifiedState;
              this.record = { ...record, state: verifiedState, verifiedBootId: info.bootId };
              await this.persist();
              return this.view;
            } else if (info.bootId !== firstObservationBootId) {
              firstObservationAt = this.now();
              firstObservationBootId = info.bootId;
              this.state = "verifying";
              await this.wait(Math.min(2_000, Math.max(0, deadline - this.now())));
            } else await this.wait(Math.min(2_000 - (this.now() - firstObservationAt), Math.max(0, deadline - this.now())));
          } else {
            firstObservationAt = null;
            firstObservationBootId = null;
            this.state = "reconnecting";
            await this.wait(Math.min(delay, Math.max(0, deadline - this.now())));
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes("does not match the enrolled recovery identity")) throw error;
          firstObservationAt = null;
          firstObservationBootId = null;
          this.state = "reconnecting";
          await this.wait(Math.min(delay, Math.max(0, deadline - this.now())));
        }
        delay = Math.min(10_000, delay + 1_000);
      }
      this.state = sawAuthenticatedDevice ? "verificationFailed" : "outcomeUnknown";
      this.detailMessage = sawExpectedRunning ? "The expected firmware is running, so paused OTA verification cannot succeed. Use explicit running-firmware reconciliation if appropriate." :
        sawAuthenticatedDevice ? null : "No authenticated device response arrived within the bounded verification window. Correct its address and continue read-only verification.";
      this.record = { ...record, state: "verificationFailed" };
      await this.persist();
      return this.view;
    } catch (error) {
      if (this.record && !["rejected", "transferFailed"].includes(this.record.state)) { this.state = "verificationFailed"; this.record = { ...this.record, state: this.state }; try { await this.persist(); } catch { /* Retain in-memory failure. */ } }
      const safeError = safeUpdateError(error, "Firmware verification failed. Keep the application paused and inspect the device over maintenance Wi-Fi.");
      this.detailMessage = safeError.message;
      throw safeError;
    } finally { this.leave(); }
  }

  async reconcileRunning(expectedBuildId: string, confirmed: boolean): Promise<FirmwareUpdateView> {
    await this.restore();
    if (!this.enter()) throw new Error("A firmware update operation is already in progress.");
    if (this.journalUnavailable) { this.leave(); throw new Error("The protected firmware update journal is unavailable."); }
    const previousState = this.state;
    try {
      const record = this.record;
      if (!confirmed || !record || expectedBuildId !== record.expectedBuildId) {
        throw new Error("Confirm the expected build before reconciling the running firmware.");
      }
      if (!record.putAttempted || record.previousBuildId === record.expectedBuildId || ["rejected", "transferFailed"].includes(record.state) ||
          !["outcomeUnknown", "verificationFailed", "waitingForReboot", "rejected"].includes(this.state)) {
        throw new Error("The previous firmware transfer failed, was rejected, or cannot be reconciled in this state.");
      }
      const credential = await this.requiredCredential();
      if (!sameBinding(record, credential)) throw new Error("The enrolled recovery identity changed; this update cannot be reconciled.");
      const history = await archiveAttempt(record, this.options.journal);
      await this.options.device.suspendAndDrain();
      this.state = "reconciling";
      this.detailMessage = null;
      const deadline = this.now() + 30_000;
      const timeout = (): number => {
        const remaining = deadline - this.now();
        if (remaining <= 0) throw new Error("The device cannot be reconciled: the observation window expired.");
        return Math.max(1, Math.min(MAINTENANCE_HTTP_TIMEOUT_MS, Math.ceil(remaining)));
      };
      const observe = async () => {
        const client = this.options.createClient(record.previousAddress, credential.token);
        const info = await client.info(timeout());
        const status = await client.status(timeout());
        const diagnostics = await client.diagnostics(timeout());
        const finalInfo = await client.info(timeout());
        if (!this.validPostBootIdentity(info, record) || !this.validPostBootIdentity(finalInfo, record) || info.bootId !== finalInfo.bootId) {
          throw new Error("The device cannot be reconciled: its identity, expected build, boot or update capacity did not match.");
        }
        if (!status.applicationRunning || !status.recoveryApRunning || !status.stationConnected || !status.configurationLoaded ||
            !status.storageAvailable || status.pendingWifi || status.volatileWifi ||
            !meetsResourceFloors(diagnostics, record)) {
          throw new Error("The device cannot be reconciled: application, network, recovery or memory health is insufficient.");
        }
        return { info, diagnostics };
      };
      const first = await observe();
      const firstAt = this.now();
      await this.wait(Math.min(2_000, Math.max(0, deadline - this.now())));
      const second = await observe();
      const intervalMs = this.now() - firstAt;
      if (intervalMs < 2_000 || this.now() >= deadline || first.info.bootId !== second.info.bootId) {
        throw new Error("The device cannot be reconciled: two stable boot observations were not obtained.");
      }
      const next: FirmwareUpdateRecord = { ...record, state: "manuallyReconciled", history,
        manualReconciliation: { bootId: second.info.bootId, observations: 2, intervalMs,
          firstFreeHeapBytes: first.diagnostics.freeHeapBytes, firstLargestBlockBytes: first.diagnostics.maxFreeBlockBytes,
          secondFreeHeapBytes: second.diagnostics.freeHeapBytes, secondLargestBlockBytes: second.diagnostics.maxFreeBlockBytes } };
      this.record = next;
      try { await this.persist(); } catch (error) { this.record = record; throw error; }
      this.state = "manuallyReconciled";
      this.detailMessage = null;
      if (this.options.device.resumeAfterManualReconciliation) this.options.device.resumeAfterManualReconciliation();
      else this.options.device.resumeAfterExplicitRun();
      return this.view;
    } catch (error) {
      if (this.state === "reconciling") this.state = previousState;
      const safeError = safeUpdateError(error, "Running-firmware reconciliation failed. The update remains blocked; check the protected journal and device health.");
      this.detailMessage = safeError.message;
      throw safeError;
    } finally { this.leave(); }
  }

  async correctAddress(address: string): Promise<FirmwareUpdateView> {
    await this.restore();
    const normalized = validateMaintenanceOrigin(address).origin;
    if (!this.enter()) throw new Error("A firmware update operation is already in progress.");
    if (this.journalUnavailable) { this.leave(); throw new Error("The protected firmware update journal is unavailable."); }
    try {
      const credential = await this.requiredCredential();
      const client = this.options.createClient(normalized, credential.token);
      const info = await client.info();
      this.assertBoundInfo(info, credential);
      const priorRecord = this.record;
      const priorState = this.state;
      const nextCredential = { ...credential, lastVerifiedAddress: normalized };
      try { await this.options.recoveryStore.set(nextCredential); }
      catch {
        let partial: RecoveryCredential | null = null;
        try { partial = await this.options.recoveryStore.get(); } catch { /* Keep the prior journal address as the fallback. */ }
        if (partial && partial.lastVerifiedAddress === normalized && sameBinding(credential, partial)) {
          try { await this.options.recoveryStore.set(credential); } catch { /* Do not switch the scheduler to an unverified address. */ }
        }
        throw new Error("The verified address could not be saved.");
      }
      let readback: RecoveryCredential | null = null;
      try { readback = await this.options.recoveryStore.get(); } catch { /* Roll back the unverified address below. */ }
      if (!readback || readback.lastVerifiedAddress !== normalized || !sameBinding(credential, readback)) {
        try { await this.options.recoveryStore.set(credential); } catch { /* The old address remains the journaled fallback. */ }
        throw new Error("The verified address could not be saved.");
      }
      try {
        await this.options.device.rebindVerifiedAddress?.(normalized, !priorRecord?.putAttempted);
        if (priorRecord?.putAttempted) {
          this.record = { ...priorRecord, previousAddress: normalized };
          await this.persist();
          this.state = priorState === "verified" || priorState === "experimentallyVerified" ? priorState : "outcomeUnknown";
        } else {
          this.candidate = null;
          this.candidatePreparedAt = 0;
          this.record = null;
          this.state = "idle";
        }
        this.effectiveAddress = normalized;
        this.detailMessage = null;
      } catch {
        this.record = priorRecord;
        this.state = priorState;
        try { await this.options.recoveryStore.set(credential); } catch { /* The last verified address remains in the journal. */ }
        try { await this.options.device.rebindVerifiedAddress?.(credential.lastVerifiedAddress, false); } catch { /* Keep the integration paused if rebinding failed. */ }
        throw new Error("The verified address could not be committed; the previous address remains active.");
      }
      return this.view;
    } finally { this.leave(); }
  }

  async runApplication(): Promise<FirmwareUpdateView> {
    await this.restore();
    if (!this.enter()) throw new Error("A firmware update operation is already in progress.");
    if (this.journalUnavailable) { this.leave(); throw new Error("The protected firmware update journal is unavailable."); }
    try {
      if (!["verified", "experimentallyVerified"].includes(this.state) || !this.record) {
        throw new Error("Only verified or experimentally verified firmware can be started explicitly.");
      }
      const credential = await this.requiredCredential();
      const client = this.options.createClient(this.record.previousAddress, credential.token);
      const info = await client.info();
      if (!this.validPostBootIdentity(info, this.record) || info.bootId !== this.record.verifiedBootId) {
        this.state = "verificationFailed";
        this.record = { ...this.record, state: this.state };
        await this.persist();
        throw new Error("The verified device identity changed before application startup; verify again.");
      }
      const status = await client.status();
      if (!status.applicationRunning) await client.run();
      if (!(await client.status()).applicationRunning) throw new Error("The application did not start; maintenance synchronization remains held.");
      const runningInfo = await client.info();
      if (!this.validPostBootIdentity(runningInfo, this.record) || runningInfo.bootId !== info.bootId) {
        this.state = "verificationFailed";
        this.record = { ...this.record, state: this.state };
        await this.persist();
        throw new Error("The verified device identity changed during application startup.");
      }
      this.state = "started";
      this.record = { ...this.record, state: "started" };
      this.options.device.resumeAfterExplicitRun();
      try { await this.persist(); } catch { /* The verified record remains safe; a later explicit action can observe the running app. */ }
      return this.view;
    } finally { this.leave(); }
  }

  private enter(): boolean { if (this.active) return false; this.active = true; return true; }
  private leave(): void { this.active = false; }
  private now(): number { return this.options.now?.() ?? Number(process.hrtime.bigint() / 1_000_000n); }
  private wait(milliseconds: number): Promise<void> { return this.options.wait?.(milliseconds) ?? new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)); }
  private async persist(): Promise<void> { if (this.record) await this.options.journal.save(this.record); }

  private async requiredCredential(): Promise<RecoveryCredential> {
    let value: RecoveryCredential | null;
    try { value = await this.options.recoveryStore.get(); } catch { throw new Error("Maintenance credentials could not be read from the system credential manager."); }
    if (!value) throw new Error("Maintenance credentials required. Enroll them in the foreground agent terminal.");
    return value;
  }

  private recordFor(candidate: PreparedFirmwareCandidate, credential: RecoveryCredential, info: MaintenanceInfo,
    state: FirmwareUpdateState, putAttempted: boolean): FirmwareUpdateRecord {
    const resources = candidate.manifest.minimumResources;
    return { version: 1, state, purpose: candidatePurpose(candidate), putAttempted, deviceId: credential.deviceId, profile: credential.profile,
      recoveryIdentityFingerprint: credential.recoveryIdentityFingerprint, previousBuildId: info.buildId, expectedBuildId: candidate.manifest.buildId,
      expectedBootId: info.bootId, sourceRevision: candidate.manifest.sourceRevision, runtimeBounds: candidate.manifest.validation.runtimeBounds,
      sha256: candidate.sha256, byteLength: candidate.byteLength,
      minimumFreeHeapBytes: resources?.minimumFreeHeapBytes ?? null,
      minimumLargestBlockBytes: resources?.minimumLargestBlockBytes ?? null,
      previousAddress: credential.lastVerifiedAddress, ...(this.record?.history ? { history: this.record.history } : {}) };
  }

  private assertBoundInfo(info: MaintenanceInfo, credential: RecoveryCredential): void {
    if (info.deviceId !== credential.deviceId || info.profile !== credential.profile ||
        info.recoveryIdentityFingerprint !== credential.recoveryIdentityFingerprint) throw new Error("The device identity does not match the enrolled maintenance record.");
  }

  private assertCapacity(info: MaintenanceInfo, candidate: PreparedFirmwareCandidate): void {
    const bounds = candidate.manifest.validation.runtimeBounds;
    if (isDeferredRuntimeBounds(bounds) && info.buildId !== bounds.requiredBuildId) throw new Error("The device does not match the reviewed installed build for deferred geometry.");
    if (!info.otaEnabled || info.maxFirmwareBytes < candidate.byteLength) throw new Error("This device build does not allow the approved firmware size or maintenance OTA.");
    if (candidate.manifest.buildId === info.buildId) throw new Error("The candidate build ID must differ from the currently running firmware.");
    if (candidate.manifest.deviceId !== info.deviceId || candidate.manifest.profile !== info.profile ||
        candidate.manifest.recoveryIdentityFingerprint !== info.recoveryIdentityFingerprint) throw new Error("The candidate identity does not match the authenticated device.");
    if (candidate.manifest.target.family !== "esp8266" || candidate.manifest.target.flashBytes !== 4_194_304 ||
        candidate.manifest.target.flashMode !== "dio" || candidate.manifest.target.flashFrequencyMHz !== 40) throw new Error("The firmware target does not match the approved device profile.");
    const regions = candidate.manifest.linkedRegions;
    if (!regions || regions.bootloaderStart !== 0 || regions.applicationStart !== 4096 || regions.filesystemStart !== 1_048_576 ||
        regions.filesystemEnd !== 4_169_728 || regions.eepromStart !== 4_173_824) throw new Error("The firmware linked layout does not match the required 4m3m profile.");
  }

  private assertPreflight(info: MaintenanceInfo, status: MaintenanceStatus, diagnostics: MaintenanceDiagnostics, candidate: PreparedFirmwareCandidate): void {
    if (status.pendingWifi || status.volatileWifi || !status.recoveryApRunning || !status.configurationLoaded) {
      throw new Error("The device is not in a stable maintenance-ready state.");
    }
    const resourceFloors = candidate.manifest.minimumResources;
    if (resourceFloors && (diagnostics.freeHeapBytes < resourceFloors.minimumFreeHeapBytes ||
        diagnostics.maxFreeBlockBytes < resourceFloors.minimumLargestBlockBytes)) throw new Error("The device does not meet the firmware manifest memory requirement.");
    if (!info.otaEnabled) throw new Error("Verified maintenance OTA is disabled in this firmware.");
  }

  private validPostBootIdentity(info: MaintenanceInfo, record: FirmwareUpdateRecord): boolean {
    return info.deviceId === record.deviceId && info.profile === record.profile && info.recoveryIdentityFingerprint === record.recoveryIdentityFingerprint &&
      info.otaEnabled && info.maxFirmwareBytes >= record.byteLength && info.bootId !== record.expectedBootId && info.buildId === record.expectedBuildId;
  }

  private validPostBootObservation(observation: { info: MaintenanceInfo; status: MaintenanceStatus; diagnostics: MaintenanceDiagnostics }, record: FirmwareUpdateRecord): boolean {
    const status = observation.status;
    return this.validPostBootIdentity(observation.info, record) && !status.applicationRunning && status.recoveryApRunning &&
      status.stationConnected && status.configurationLoaded && status.storageAvailable && !status.pendingWifi && !status.volatileWifi &&
      meetsResourceFloors(observation.diagnostics, record);
  }
}

async function archiveAttempt(record: FirmwareUpdateRecord, journal: FirmwareUpdateJournal): Promise<FirmwareUpdateHistoryEntry[]> {
  const { history, ...snapshot } = record;
  const previous = history ?? [];
  if (previous.length >= 8) {
    if (!journal.archive) throw new Error("The protected update history cannot be archived safely.");
    await journal.archive([previous[0]!]);
    return [...previous.slice(1), snapshot];
  }
  return [...previous, snapshot];
}

function sameBinding(left: Pick<RecoveryCredential, "deviceId" | "profile" | "recoveryIdentityFingerprint">,
  right: Pick<RecoveryCredential, "deviceId" | "profile" | "recoveryIdentityFingerprint">): boolean {
  return left.deviceId === right.deviceId && left.profile === right.profile && left.recoveryIdentityFingerprint === right.recoveryIdentityFingerprint;
}

function safeUpdateError(error: unknown, fallback: string): Error {
  if (error instanceof MaintenanceRequestError) return error;
  if (error instanceof MaintenanceTransportError) return error;
  if (error instanceof Error && /^(Prepare firmware again|A firmware update|Explicit experimental authorization|Deferred device geometry confirmation|Maintenance credentials required|Maintenance credentials could|The device identity|The responding device|The enrolled recovery identity|The device does not|This device build|The firmware target|The device is not|The application did not|The device does not meet|Only verified firmware|There is no attempted firmware|Confirm the expected build|The device cannot be reconciled|The previous firmware transfer|The protected update history|The reconciled device)/.test(error.message)) return error;
  return new Error(fallback);
}
