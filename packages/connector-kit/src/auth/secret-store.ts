/**
 * The operating system's credential store: macOS Keychain, Windows
 * Credential Manager, or the Secret Service (libsecret over D-Bus) on Linux.
 * Connectors keep only a small key here (see `SealedCache`); the token cache
 * itself is too big for Credential Manager.
 */
export interface SecretStore {
  /** The stored value, or `undefined` when there is no such entry. Rejects when the store can't be used. */
  get(name: string): Promise<string | undefined>
  /** Create or replace an entry. Rejects when the store can't be used. */
  set(name: string, value: string): Promise<void>
  /** `true` when an entry was removed. Rejects when the store can't be used. */
  delete(name: string): Promise<boolean>
}

/** Service name of every Maximal connector entry in the OS credential store. */
export const SECRET_SERVICE = "Maximal connectors"

type BunSecrets = typeof Bun.secrets

function bunSecrets(): BunSecrets {
  // `bun test` never reaches the real Keychain / Credential Manager, even
  // when a test forgets to inject a store: the connector keeps tokens in
  // memory instead.
  if (process.env.NODE_ENV === "test")
    throw new Error("The OS credential store is not used under test.")
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- absent outside Bun or on an older Bun
  if (typeof Bun === "undefined" || !Bun.secrets)
    throw new Error("This runtime has no OS credential store API.")
  return Bun.secrets
}

/**
 * The OS credential store through `Bun.secrets` (Keychain Services,
 * Credential Manager, libsecret). Bun runs these calls off the event loop.
 * Values never appear on a command line.
 */
export function osSecretStore(service = SECRET_SERVICE): SecretStore {
  return {
    async get(name) {
      const value = await bunSecrets().get({ service, name })
      return value ?? undefined
    },
    async set(name, value) {
      await bunSecrets().set({ service, name, value })
    },
    async delete(name) {
      return await bunSecrets().delete({ service, name })
    },
  }
}

/** `store` with every entry name prefixed by `<prefix>/` (one connector's entries). */
export function scopedSecretStore(
  store: SecretStore,
  prefix: string,
): SecretStore {
  const scoped = (name: string) => `${prefix}/${name}`
  return {
    get: (name) => store.get(scoped(name)),
    set: (name, value) => store.set(scoped(name), value),
    delete: (name) => store.delete(scoped(name)),
  }
}
