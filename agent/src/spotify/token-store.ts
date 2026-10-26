import { CredentialStoreError } from "./errors.js";

export interface RefreshTokenStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

type KeyringOptions = { linux: { store: "secret-service" } };
type AsyncCredentialEntry = {
  getPassword(): Promise<string | null | undefined>;
  setPassword(password: string): Promise<void>;
  deletePassword(): Promise<unknown>;
};
type AsyncCredentialEntryConstructor = new (
  service: string,
  account: string,
  options?: KeyringOptions,
) => AsyncCredentialEntry;

/** Stores only the refresh token in the user's native credential manager. */
export class SystemRefreshTokenStore implements RefreshTokenStore {
  private entryPromise?: Promise<AsyncCredentialEntry>;

  async get(): Promise<string | null> {
    try {
      const token = await (await this.entry()).getPassword();
      return typeof token === "string" && token.length > 0 ? token : null;
    } catch {
      throw new CredentialStoreError();
    }
  }

  async set(token: string): Promise<void> {
    try {
      await (await this.entry()).setPassword(token);
    } catch {
      throw new CredentialStoreError();
    }
  }

  async clear(): Promise<void> {
    try {
      await (await this.entry()).deletePassword();
    } catch {
      // A missing credential is already the desired state.
      const current = await this.get();
      if (current !== null) {
        throw new CredentialStoreError();
      }
    }
  }

  private entry(): Promise<AsyncCredentialEntry> {
    this.entryPromise ??= import("@napi-rs/keyring")
      .then(({ AsyncEntry }) => {
        // Upstream documents the Linux backend option, though the published type omits it.
        const Entry = AsyncEntry as unknown as AsyncCredentialEntryConstructor;
        return new Entry("NeonByte", "spotify-refresh-token", {
          linux: { store: "secret-service" },
        });
      })
      .catch(() => {
        throw new CredentialStoreError();
      });
    return this.entryPromise;
  }
}
