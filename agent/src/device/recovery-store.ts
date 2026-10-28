import { createHash } from "node:crypto";
import { MaintenanceClient, validateMaintenanceOrigin, type MaintenanceInfo } from "./maintenance-client.js";

export const RECOVERY_CREDENTIAL_SERVICE = "NeonByte";
export const RECOVERY_CREDENTIAL_ACCOUNT = "device-maintenance-v1";
const FINGERPRINT_DOMAIN = "NeonByte recovery identity v1\0";

export interface RecoveryCredential {
  version: 1;
  token: string;
  deviceId: string;
  recoveryIdentityFingerprint: string;
  lastVerifiedAddress: string;
  profile: string;
}

export interface RecoveryCredentialStore {
  get(): Promise<RecoveryCredential | null>;
  set(value: RecoveryCredential): Promise<void>;
  delete(): Promise<void>;
}

export function computeRecoveryIdentityFingerprint(token: string, apPassword: string): string {
  return createHash("sha256").update(FINGERPRINT_DOMAIN, "ascii").update(token, "ascii")
    .update("\0", "ascii").update(apPassword, "ascii").digest("hex");
}

export function isValidRecoveryCredential(value: unknown): value is RecoveryCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = ["version", "token", "deviceId", "recoveryIdentityFingerprint", "lastVerifiedAddress", "profile"];
  if (Object.keys(item).length !== keys.length || !keys.every((key) => Object.hasOwn(item, key)) || item["version"] !== 1 ||
      typeof item["token"] !== "string" || !/^[a-f0-9]{64}$/.test(item["token"]) ||
      typeof item["deviceId"] !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(item["deviceId"]) ||
      typeof item["recoveryIdentityFingerprint"] !== "string" || !/^[a-f0-9]{64}$/.test(item["recoveryIdentityFingerprint"]) ||
      typeof item["profile"] !== "string" || !/^[A-Za-z0-9._:-]{1,96}$/.test(item["profile"]) ||
      typeof item["lastVerifiedAddress"] !== "string") return false;
  try { return validateMaintenanceOrigin(item["lastVerifiedAddress"]).origin === item["lastVerifiedAddress"]; }
  catch { return false; }
}

export class SystemRecoveryCredentialStore implements RecoveryCredentialStore {
  private async entry() {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    const Entry = AsyncEntry as unknown as new (service: string, account: string, options: { linux: { store: "secret-service" } }) => {
      getPassword(): Promise<string | null | undefined>;
      setPassword(value: string): Promise<void>;
      deletePassword(): Promise<boolean>;
    };
    return new Entry(RECOVERY_CREDENTIAL_SERVICE, RECOVERY_CREDENTIAL_ACCOUNT, { linux: { store: "secret-service" } });
  }

  async get(): Promise<RecoveryCredential | null> {
    try {
      const serialized = await (await this.entry()).getPassword();
      if (!serialized) return null;
      const parsed: unknown = JSON.parse(serialized);
      if (!isValidRecoveryCredential(parsed)) throw new Error();
      return { ...parsed };
    } catch { throw new Error("Unable to read verified maintenance credentials from the system credential manager."); }
  }

  async set(value: RecoveryCredential): Promise<void> {
    if (!isValidRecoveryCredential(value)) throw new Error("The maintenance credential record is invalid.");
    try { await (await this.entry()).setPassword(JSON.stringify(value)); }
    catch { throw new Error("Unable to save maintenance credentials in the system credential manager."); }
  }

  async delete(): Promise<void> {
    try { await (await this.entry()).deletePassword(); }
    catch { throw new Error("Unable to remove an unverified maintenance credential record."); }
  }
}

export async function enrollRecoveryCredential(input: {
  store: RecoveryCredentialStore;
  client: Pick<MaintenanceClient, "info">;
  token: string;
  apPassword: string;
  address: string;
  expectedDeviceId: string;
  expectedProfile: string;
  expectedFingerprint: string;
}): Promise<RecoveryCredential> {
  const existing = await input.store.get();
  if (existing) throw new Error("Maintenance credentials are already enrolled; a separate reviewed replacement is required.");
  if (!/^[a-f0-9]{64}$/.test(input.token) || !/^[a-f0-9]{32}$/.test(input.apPassword) ||
      !/^[a-f0-9]{64}$/.test(input.expectedFingerprint) ||
      computeRecoveryIdentityFingerprint(input.token, input.apPassword) !== input.expectedFingerprint) {
    throw new Error("Recovery identity could not be verified against the trusted private record.");
  }
  const address = validateMaintenanceOrigin(input.address).origin;

  let info: MaintenanceInfo;
  try { info = await input.client.info(); }
  catch { throw new Error("Authenticated maintenance identity could not be verified on the expected device."); }
  if (info.deviceId !== input.expectedDeviceId || info.profile !== input.expectedProfile ||
      info.recoveryIdentityFingerprint !== input.expectedFingerprint) {
    throw new Error("Authenticated maintenance identity could not be verified on the expected device.");
  }

  const value: RecoveryCredential = { version: 1, token: input.token, deviceId: input.expectedDeviceId,
    recoveryIdentityFingerprint: input.expectedFingerprint, lastVerifiedAddress: address, profile: input.expectedProfile };
  await input.store.set(value);
  let actual: RecoveryCredential | null = null;
  try { actual = await input.store.get(); } catch { /* Delete the new record below. */ }
  if (!actual || JSON.stringify(actual) !== JSON.stringify(value)) {
    try { await input.store.delete(); } catch { /* The unverified record remains unusable because every read validates it. */ }
    throw new Error("Maintenance credentials could not be verified in the credential manager.");
  }
  return value;
}
