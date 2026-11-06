import type { SecretStore } from "../auth/secret-store"

/** An in-memory OS credential store for tests: never the real Keychain or Credential Manager. */
export interface MemorySecretStore extends SecretStore {
  readonly entries: Map<string, string>
  /** When set, every call rejects with it, like Linux without a Secret Service. */
  unavailable: Error | undefined
  /** Calls made, in order (`get` / `set` / `delete` and the entry name). */
  readonly calls: Array<string>
}

export function memorySecretStore(
  options: { unavailable?: Error } = {},
): MemorySecretStore {
  const entries = new Map<string, string>()
  const calls: Array<string> = []
  const store: MemorySecretStore = {
    entries,
    calls,
    unavailable: options.unavailable,
    get(name) {
      calls.push(`get ${name}`)
      if (store.unavailable) return Promise.reject(store.unavailable)
      return Promise.resolve(entries.get(name))
    },
    set(name, value) {
      calls.push(`set ${name}`)
      if (store.unavailable) return Promise.reject(store.unavailable)
      entries.set(name, value)
      return Promise.resolve()
    },
    delete(name) {
      calls.push(`delete ${name}`)
      if (store.unavailable) return Promise.reject(store.unavailable)
      return Promise.resolve(entries.delete(name))
    },
  }
  return store
}
