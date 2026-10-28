import { createInterface } from "node:readline/promises";
import type { EnrollmentPrompts } from "./recovery-enrollment.js";

export interface RawTerminalInput {
  isTTY?: boolean;
  setRawMode?(enabled: boolean): void;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

export interface TerminalOutput { write(value: string): unknown }

export function readHiddenTerminalValue(label: string, input: RawTerminalInput, output: TerminalOutput): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(new Error("Run recovery enrollment from a foreground interactive terminal."));
  }
  output.write(`${label}: `);
  input.setRawMode(true);
  input.resume();

  return new Promise<string>((resolve, reject) => {
    let value = "";
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
      output.write("\n");
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const byte of bytes) {
        if (byte === 0x03) {
          cleanup();
          reject(new Error("Recovery enrollment was cancelled."));
          return;
        }
        if (byte === 0x0a || byte === 0x0d) {
          cleanup();
          resolve(value);
          return;
        }
        if (byte === 0x08 || byte === 0x7f) {
          value = value.slice(0, -1);
          continue;
        }
        if (byte >= 0x20 && byte <= 0x7e) value += String.fromCharCode(byte);
      }
    };
    input.on("data", onData);
  });
}

async function askLine(label: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await prompt.question(`${label}: `)).trim(); }
  finally { prompt.close(); }
}

export interface DeviceConfigurationPrompts {
  address(): Promise<string>;
  token(): Promise<string>;
  enabled(): Promise<boolean>;
}

export function createDeviceConfigurationPrompts(): DeviceConfigurationPrompts {
  return {
    address: () => askLine("Private device IPv4 HTTP origin"),
    token: () => readHiddenTerminalValue("Device pairing bearer token", process.stdin, process.stdout),
    enabled: async () => (await askLine("Enable device synchronization now? Type yes to enable")).toLowerCase() === "yes",
  };
}

export function createRecoveryEnrollmentPrompts(): EnrollmentPrompts {
  return {
    address: () => askLine("Private device IPv4 HTTP origin"),
    expectedDeviceId: () => askLine("Trusted device ID from the private build record"),
    expectedProfile: () => askLine("Trusted firmware profile from the private build record"),
    expectedFingerprint: () => askLine("Trusted recovery identity SHA-256 fingerprint"),
    reusePairingToken: async () => (await askLine("Reuse the saved pairing token as the recovery credential? Type yes to opt in")).toLowerCase() === "yes",
    recoveryToken: () => readHiddenTerminalValue("Recovery bearer token", process.stdin, process.stdout),
    apPassword: () => readHiddenTerminalValue("Recovery AP password", process.stdin, process.stdout),
  };
}
