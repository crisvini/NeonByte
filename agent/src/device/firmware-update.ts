import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { rename, mkdir, open, lstat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { MAINTENANCE_HTTP_TIMEOUT_MS, MaintenanceRequestError, MaintenanceTransportError, type MaintenanceClient, type MaintenanceDiagnostics, type MaintenanceInfo, type MaintenanceStatus, validateMaintenanceOrigin } from "./maintenance-client.js";
import { FirmwareInbox, verifyLocalProtectedAccess, type PreparedFirmwareCandidate } from "./firmware-inbox.js";
import type { RecoveryCredential, RecoveryCredentialStore } from "./recovery-store.js";

export type FirmwareUpdateState = "idle" | "preparing" | "ready" | "preflight" | "pausing" | "uploading" |
  "waitingForReboot" | "reconnecting" | "verifying" | "verified" | "rejected" | "transferFailed" |
  "verificationFailed" | "outcomeUnknown" | "started";

export interface FirmwareUpdateRecord {
  version: 1;
  state: FirmwareUpdateState;
  putAttempted: boolean;
  deviceId: string;
  profile: string;
  recoveryIdentityFingerprint: string;
  previousBuildId: string;
  expectedBuildId: string;
  expectedBootId: string;
  sha256: string;
  byteLength: number;
  minimumFreeHeapBytes: number;
  minimumLargestBlockBytes: number;
  previousAddress: string;
}

export interface FirmwareUpdateJournal {
  load(): Promise<FirmwareUpdateRecord | null>;
  save(value: FirmwareUpdateRecord): Promise<void>;
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
  "waitingForReboot", "reconnecting", "verifying", "verified", "rejected", "transferFailed", "verificationFailed", "outcomeUnknown", "started"]);

function validRecord(value: unknown): value is FirmwareUpdateRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = ["version", "state", "putAttempted", "deviceId", "profile", "recoveryIdentityFingerprint", "previousBuildId", "expectedBuildId", "expectedBootId",
    "sha256", "byteLength", "minimumFreeHeapBytes", "minimumLargestBlockBytes", "previousAddress"];
  if (Object.keys(item).length !== keys.length || !keys.every((key) => Object.hasOwn(item, key)) || item["version"] !== 1 ||
      typeof item["state"] !== "string" || !validStates.has(item["state"] as FirmwareUpdateState) || typeof item["putAttempted"] !== "boolean" ||
      typeof item["deviceId"] !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(item["deviceId"]) ||
      typeof item["profile"] !== "string" || !/^[A-Za-z0-9._:-]{1,96}$/.test(item["profile"]) ||
      typeof item["recoveryIdentityFingerprint"] !== "string" || !/^[a-f0-9]{64}$/.test(item["recoveryIdentityFingerprint"]) ||
      typeof item["previousBuildId"] !== "string" || !/^[A-Za-z0-9._:-]{1,96}$/.test(item["previousBuildId"]) ||
      typeof item["expectedBuildId"] !== "string" || !/^[A-Za-z0-9._:-]{1,96}$/.test(item["expectedBuildId"]) ||
      typeof item["expectedBootId"] !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(item["expectedBootId"]) ||
      typeof item["sha256"] !== "string" || !/^[a-f0-9]{64}$/.test(item["sha256"]) ||
      !Number.isSafeInteger(item["byteLength"]) || Number(item["byteLength"]) < 1 || Number(item["byteLength"]) > 458_752 ||
      !Number.isSafeInteger(item["minimumFreeHeapBytes"]) || Number(item["minimumFreeHeapBytes"]) < 1 ||
      !Number.isSafeInteger(item["minimumLargestBlockBytes"]) || Number(item["minimumLargestBlockBytes"]) < 1 ||
      typeof item["previousAddress"] !== "string") return false;
  try { return validateMaintenanceOrigin(item["previousAddress"]).origin === item["previousAddress"]; }
  catch { return false; }
}

interface MaintenanceClientPort extends Pick<MaintenanceClient, "info" | "status" | "diagnostics" | "pause" | "run" | "uploadFirmware"> {}
interface FirmwareInboxPort { prepare(binding: Pick<RecoveryCredential, "deviceId" | "profile" | "recoveryIdentityFingerprint">): Promise<PreparedFirmwareCandidate> }
interface UpdateDeviceControl {
  suspendAndDrain(): Promise<void>;
  holdForMaintenance?(): void;
  resumeAfterExplicitRun(): void;
  rebindVerifiedAddress?(address: string, resumeScheduler?: boolean): Promise<void>;
}

export interface FirmwareUpdateView {
  state: FirmwareUpdateState;
  candidate: null | { id: string; fileName: "firmware.bin"; byteLength: number; sha256: string; expectedBuildId: string; deviceId: string };
  bytesSent: number;
  totalBytes: number;
  message: string;
  putAttempted: boolean;
  effectiveAddress: string;
}

const messages: Record<FirmwareUpdateState, string> = {
  idle: "No firmware update is prepared.", preparing: "Checking local firmware and device identity.", ready: "Firmware is ready for explicit confirmation.",
  preflight: "Checking device identity, capacity, and maintenance state.", pausing: "Pausing application synchronization and display work.",
  uploading: "Sending the approved firmware image.", waitingForReboot: "The device accepted the image and is expected to reboot.",
  reconnecting: "Checking the device over its last verified address.", verifying: "Checking firmware identity and maintenance health.",
  verified: "The expected firmware passed two maintenance observations. Start the application when ready.",
  rejected: "Firmware preparation or device validation was rejected. No automatic retry or application startup was requested.",
  transferFailed: "The firmware transfer did not complete. The application remains paused; do not retry automatically.",
  verificationFailed: "The expected firmware could not be verified. The application remains paused.",
  outcomeUnknown: "The firmware response was lost. Reconnect and verify; the image will not be sent again.",
  started: "The verified application was started explicitly.",
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
    return { state: this.state,
      candidate: this.candidate ? { id: this.candidate.id, fileName: this.candidate.fileName, byteLength: this.candidate.byteLength,
        sha256: this.candidate.sha256, expectedBuildId: this.candidate.manifest.buildId, deviceId: this.candidate.manifest.deviceId } : null,
      bytesSent: this.bytesSent, totalBytes: this.candidate?.byteLength ?? record?.byteLength ?? 0,
      message: this.journalUnavailable ? "The protected update journal is unavailable. Firmware will not be sent or replayed." : this.detailMessage ?? messages[this.state],
      putAttempted: record?.putAttempted ?? false, effectiveAddress: this.effectiveAddress || record?.previousAddress || "" };
  }

  async getStatus(): Promise<FirmwareUpdateView> {
    await this.restore();
    try { this.effectiveAddress = (await this.options.recoveryStore.get())?.lastVerifiedAddress ?? ""; }
    catch { this.effectiveAddress = ""; }
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
    if (record.putAttempted && record.state !== "started") {
      this.options.device.holdForMaintenance?.();
      if (record.state === "verified") this.state = "verified";
      else {
        this.state = "outcomeUnknown";
        this.record = { ...record, state: "outcomeUnknown" };
        await this.options.journal.save(this.record);
      }
    } else if (record.state === "verified") this.state = "verified";
    else if (record.state === "started") this.state = "started";
    else this.state = "idle";
  }

  async prepare(): Promise<FirmwareUpdateView> {
    await this.restore();
    if (!this.enter()) throw new Error("A firmware update operation is already in progress.");
    if (this.journalUnavailable) { this.leave(); throw new Error("The protected firmware update journal is unavailable."); }
    if (this.record?.putAttempted && this.state !== "started") {
      this.leave();
      throw new Error("Verify or explicitly start the previous firmware before preparing another update.");
    }
    try {
      this.candidate = null; this.candidatePreparedAt = 0; this.bytesSent = 0; this.state = "preparing";
      this.detailMessage = null;
      const credential = await this.requiredCredential();
      this.effectiveAddress = credential.lastVerifiedAddress;
      const candidate = await (this.options.inbox ?? new FirmwareInbox()).prepare(credential);
      const info = await this.options.createClient(credential.lastVerifiedAddress, credential.token).info();
      this.assertBoundInfo(info, credential);
      this.assertCapacity(info, candidate);
      this.candidate = candidate;
      this.record = this.recordFor(candidate, credential, info, "ready", false);
      this.candidatePreparedAt = this.now();
      await this.persist();
      this.state = "ready";
      return this.view;
    } catch (error) {
      this.candidate = null; this.state = "rejected";
      const safeError = safeUpdateError(error, "Firmware preparation failed. Verify the local manifest and enrolled device identity.");
      this.detailMessage = safeError.message;
      throw safeError;
    } finally { this.leave(); }
  }

  async confirm(candidateId: string): Promise<FirmwareUpdateView> {
    await this.restore();
    if (!this.enter()) throw new Error("A firmware update operation is already in progress.");
    if (this.journalUnavailable) { this.leave(); throw new Error("The protected firmware update journal is unavailable."); }
    try {
      const candidate = this.candidate;
      if (!candidate || this.state !== "ready" || candidate.id !== candidateId) throw new Error("Prepare firmware again before confirming this update.");
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
      await client.pause();
      if ((await client.status()).applicationRunning) throw new Error("The application did not pause; no firmware was sent.");

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
      } else if (this.state !== "ready" && this.state !== "idle") {
        this.state = "rejected";
        this.candidate = null;
        this.candidatePreparedAt = 0;
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
          if (this.validPostBootObservation(observation, record)) {
            if (firstObservationAt === null) {
              firstObservationAt = this.now();
              firstObservationBootId = info.bootId;
              this.state = "verifying";
              await this.wait(Math.min(2_000, Math.max(0, deadline - this.now())));
            } else if (info.bootId === firstObservationBootId && this.now() - firstObservationAt >= 2_000 && this.now() < deadline) {
              this.state = "verified";
              this.record = { ...record, state: "verified" };
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
      this.detailMessage = sawAuthenticatedDevice ? null : "No authenticated device response arrived within the bounded verification window. Correct its address and continue read-only verification.";
      this.record = { ...record, state: "verificationFailed" };
      await this.persist();
      return this.view;
    } catch (error) {
      if (this.record) { this.state = "verificationFailed"; this.record = { ...this.record, state: this.state }; try { await this.persist(); } catch { /* Retain in-memory failure. */ } }
      const safeError = safeUpdateError(error, "Firmware verification failed. Keep the application paused and inspect the device over maintenance Wi-Fi.");
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
          this.state = priorState === "verified" ? "verified" : "outcomeUnknown";
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
      if (this.state !== "verified" || !this.record) throw new Error("Only verified firmware can be started explicitly.");
      const credential = await this.requiredCredential();
      const client = this.options.createClient(this.record.previousAddress, credential.token);
      const info = await client.info();
      if (!this.validPostBootIdentity(info, this.record)) throw new Error("The verified device identity changed before application startup.");
      const status = await client.status();
      if (!status.applicationRunning) await client.run();
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
    return { version: 1, state, putAttempted, deviceId: credential.deviceId, profile: credential.profile,
      recoveryIdentityFingerprint: credential.recoveryIdentityFingerprint, previousBuildId: info.buildId, expectedBuildId: candidate.manifest.buildId,
      expectedBootId: info.bootId, sha256: candidate.sha256, byteLength: candidate.byteLength,
      minimumFreeHeapBytes: candidate.manifest.minimumResources.minimumFreeHeapBytes,
      minimumLargestBlockBytes: candidate.manifest.minimumResources.minimumLargestBlockBytes,
      previousAddress: credential.lastVerifiedAddress };
  }

  private assertBoundInfo(info: MaintenanceInfo, credential: RecoveryCredential): void {
    if (info.deviceId !== credential.deviceId || info.profile !== credential.profile ||
        info.recoveryIdentityFingerprint !== credential.recoveryIdentityFingerprint) throw new Error("The device identity does not match the enrolled maintenance record.");
  }

  private assertCapacity(info: MaintenanceInfo, candidate: PreparedFirmwareCandidate): void {
    if (!info.otaEnabled || info.maxFirmwareBytes < candidate.byteLength) throw new Error("This device build does not allow the approved firmware size or maintenance OTA.");
    if (candidate.manifest.buildId === info.buildId) throw new Error("The candidate build ID must differ from the currently running firmware.");
    if (candidate.manifest.target.family !== "esp8266" || candidate.manifest.target.flashBytes !== 4_194_304 ||
        candidate.manifest.target.flashMode !== "dio" || candidate.manifest.target.flashFrequencyMHz !== 40) throw new Error("The firmware target does not match the approved device profile.");
  }

  private assertPreflight(info: MaintenanceInfo, status: MaintenanceStatus, diagnostics: MaintenanceDiagnostics, candidate: PreparedFirmwareCandidate): void {
    if (status.pendingWifi || status.volatileWifi || !status.recoveryApRunning || !status.configurationLoaded || !status.applicationRunning) {
      throw new Error("The device is not in a stable maintenance-ready state.");
    }
    if (diagnostics.freeHeapBytes < candidate.manifest.minimumResources.minimumFreeHeapBytes ||
        diagnostics.maxFreeBlockBytes < candidate.manifest.minimumResources.minimumLargestBlockBytes) throw new Error("The device does not meet the firmware manifest memory requirement.");
    if (!info.otaEnabled) throw new Error("Verified maintenance OTA is disabled in this firmware.");
  }

  private validPostBootIdentity(info: MaintenanceInfo, record: FirmwareUpdateRecord): boolean {
    return info.deviceId === record.deviceId && info.profile === record.profile && info.recoveryIdentityFingerprint === record.recoveryIdentityFingerprint &&
      info.otaEnabled && info.maxFirmwareBytes >= record.byteLength && info.bootId !== record.expectedBootId && info.buildId === record.expectedBuildId;
  }

  private validPostBootObservation(observation: { info: MaintenanceInfo; status: MaintenanceStatus; diagnostics: MaintenanceDiagnostics }, record: FirmwareUpdateRecord): boolean {
    return this.validPostBootIdentity(observation.info, record) && !observation.status.applicationRunning && observation.status.recoveryApRunning &&
      observation.diagnostics.freeHeapBytes >= record.minimumFreeHeapBytes && observation.diagnostics.maxFreeBlockBytes >= record.minimumLargestBlockBytes;
  }
}

function sameBinding(left: Pick<RecoveryCredential, "deviceId" | "profile" | "recoveryIdentityFingerprint">,
  right: Pick<RecoveryCredential, "deviceId" | "profile" | "recoveryIdentityFingerprint">): boolean {
  return left.deviceId === right.deviceId && left.profile === right.profile && left.recoveryIdentityFingerprint === right.recoveryIdentityFingerprint;
}

function safeUpdateError(error: unknown, fallback: string): Error {
  if (error instanceof MaintenanceRequestError) return error;
  if (error instanceof MaintenanceTransportError) return error;
  if (error instanceof Error && /^(Prepare firmware again|A firmware update|Maintenance credentials required|Maintenance credentials could|The device identity|The responding device|The enrolled recovery identity|The device does not|This device build|The firmware target|The device is not|The application did not|The device does not meet|Only verified firmware|There is no attempted firmware)/.test(error.message)) return error;
  return new Error(fallback);
}
