import type { DeviceConfigStore } from "./integration.js";
import { enrollRecoveryCredential, type RecoveryCredentialStore } from "./recovery-store.js";
import { MaintenanceClient } from "./maintenance-client.js";

export interface EnrollmentPrompts {
  address(): Promise<string>;
  expectedDeviceId(): Promise<string>;
  expectedProfile(): Promise<string>;
  expectedFingerprint(): Promise<string>;
  reusePairingToken(): Promise<boolean>;
  recoveryToken(): Promise<string>;
  apPassword(): Promise<string>;
}

export interface EnrollmentResult {
  deviceId: string;
  profile: string;
  lastVerifiedAddress: string;
}

export async function runRecoveryEnrollment(input: {
  prompts: EnrollmentPrompts;
  deviceStore: DeviceConfigStore;
  recoveryStore: RecoveryCredentialStore;
  createClient?: (address: string, token: string) => Pick<MaintenanceClient, "info">;
}): Promise<EnrollmentResult> {
  const address = (await input.prompts.address()).trim();
  const expectedDeviceId = (await input.prompts.expectedDeviceId()).trim();
  const expectedProfile = (await input.prompts.expectedProfile()).trim();
  const expectedFingerprint = (await input.prompts.expectedFingerprint()).trim();
  const deviceConfig = await input.deviceStore.get();
  const mayReusePairing = Boolean(deviceConfig?.token) && await input.prompts.reusePairingToken();
  const token = mayReusePairing ? deviceConfig!.token : await input.prompts.recoveryToken();
  const apPassword = await input.prompts.apPassword();
  const createClient = input.createClient ?? ((baseUrl, recoveryToken) => new MaintenanceClient({ baseUrl, token: recoveryToken }));

  const record = await enrollRecoveryCredential({
    store: input.recoveryStore,
    client: createClient(address, token),
    token,
    apPassword,
    address,
    expectedDeviceId,
    expectedProfile,
    expectedFingerprint,
  });
  return { deviceId: record.deviceId, profile: record.profile, lastVerifiedAddress: record.lastVerifiedAddress };
}
