import type { PluginLogger } from "@stuffbucket/maximal-plugin-sdk"

import type { SecretStore } from "./secret-store"
import type { CredentialNotice, TextStore } from "./token-provider"

/** `format` of a sealed file. */
const SEALED_FORMAT = "maximal-sealed/1"

/** What a sealed file holds: AES-256-GCM ciphertext and the name of its key's entry. */
interface SealedFile {
  format: typeof SEALED_FORMAT
  alg: "A256GCM"
  /** Entry in the OS credential store holding the key (a name, not a secret). */
  key: string
  /** 12-byte nonce, base64. */
  iv: string
  /** Ciphertext with the GCM tag appended, base64. */
  data: string
}

interface Key {
  name: string
  key: CryptoKey
}

/** Status wording when the OS credential store can't be used on `platform`. */
export function memoryOnlyNotice(platform: string): CredentialNotice {
  const fact = "Kept until Maximal restarts"
  const after =
    "so this sign-in is kept in memory only and you'll need to sign in again after Maximal restarts."
  switch (platform) {
    case "darwin": {
      return {
        fact,
        detail: `Maximal couldn't use the macOS Keychain, ${after} Allow Maximal to use the Keychain when macOS asks, then restart Maximal.`,
      }
    }
    case "win32": {
      return {
        fact,
        detail: `Maximal couldn't use Windows Credential Manager, ${after}`,
      }
    }
    default: {
      return {
        fact,
        detail: `No system keyring (Secret Service) is available, ${after} On Ubuntu or Debian, install gnome-keyring and libsecret-1-0, use a desktop session that unlocks the keyring at login, then restart Maximal.`,
      }
    }
  }
}

export interface SealedCacheOptions {
  /** The connector's private storage; holds only the sealed (encrypted) file. */
  store: TextStore
  /** The OS credential store; holds only the key. */
  secrets: SecretStore
  /** Sealed file name in `store`. */
  file: string
  /** Entry name prefix in `secrets`; a random key id is appended. */
  keyName: string
  /**
   * What identifies this cache across instances in one process (connector id
   * and data directory): a connector is rebuilt whenever it is turned off and
   * on or reconfigured, and a sign-in kept in memory must survive that.
   */
  scope: string
  /** Called once per scope and process when a store call times out. */
  onTimeout?: (notice: CredentialNotice) => void
  logger?: PluginLogger
  /** For the memory-only wording (default `process.platform`). */
  platform?: string
  /** Longest wait for one store call (default `SECRET_STORE_TIMEOUT_MS`). */
  timeoutMs?: number
  /** Wait before using the store again after it refused (default `SECRET_STORE_RETRY_MS`). */
  retryMs?: number
  now?: () => number
}

/**
 * Longest wait for one call to the OS credential store. Long, because macOS
 * may be waiting for the person to answer a Keychain prompt; the store runs
 * off the event loop, so only this cache's callers wait.
 */
export const SECRET_STORE_TIMEOUT_MS = 60_000

/** After the store refused a call (a keyring not unlocked yet), when to try again. */
export const SECRET_STORE_RETRY_MS = 5 * 60_000

/** What one scope keeps for the life of the process (see `SealedCacheOptions.scope`). */
interface ScopeState {
  /** The newest text that couldn't be sealed; it wins over the file until sealed. */
  memory?: string
  /** Why the store isn't used right now, and from when to try it again. */
  unavailable?: { notice: CredentialNotice; retryAt: number }
  /** Why the latest text lives in memory (shown while `memory` is set). */
  notice?: CredentialNotice
  /** A call timed out: the store is not used again in this process. */
  timedOut?: boolean
}

const scopes = new Map<string, ScopeState>()

/** Forget every scope's in-memory sign-in and store state (tests). */
export function resetSealedCacheScopes(): void {
  scopes.clear()
}

class StoreTimeoutError extends Error {}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(Buffer.from(text, "base64"))

function parseSealed(text: string): SealedFile | undefined {
  try {
    const value = JSON.parse(text) as Partial<SealedFile> | null
    if (
      value?.format === SEALED_FORMAT
      && value.alg === "A256GCM"
      && typeof value.key === "string"
      && typeof value.iv === "string"
      && typeof value.data === "string"
    )
      return value as SealedFile
  } catch {
    // Not JSON: treated as unreadable.
  }
  return undefined
}

async function importKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ])
}

/** Binds a ciphertext to its key's entry name. */
const additionalData = (name: string) =>
  new TextEncoder().encode(`${SEALED_FORMAT}\n${name}`)

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/**
 * One secret text (a token cache) kept off disk in usable form: envelope
 * encryption with a random AES-256-GCM key held in the OS credential store
 * and the ciphertext in the connector's storage. The key is 44 characters,
 * far under Windows Credential Manager's 2.5 KB blob limit that a whole MSAL
 * cache exceeds; reading or writing the cache touches the store at most
 * once per key, so macOS asks about Keychain access at most once per start.
 *
 * When the store can't be used (no Secret Service on Linux, access denied, a
 * call that times out), the newest text is kept in memory for the rest of the
 * process, under `scope`, and never written in plain text; `memoryOnly` says
 * so. A refused call is retried after `retryMs`, and the text is sealed once
 * the store works again; after a timeout the store isn't used again until
 * Maximal restarts. The sealed file is never deleted because the store
 * failed. Operations run one at a time, and no store call can hold them up
 * for longer than `timeoutMs`.
 */
export class SealedCache {
  readonly #options: SealedCacheOptions
  readonly #now: () => number
  #queue: Promise<unknown> = Promise.resolve()
  #key: Key | undefined

  constructor(options: SealedCacheOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
  }

  get #state(): ScopeState {
    let state = scopes.get(this.#options.scope)
    if (!state) {
      state = {}
      scopes.set(this.#options.scope, state)
    }
    return state
  }

  /** Set while the sign-in lives in memory only (it won't survive a restart). */
  get memoryOnly(): CredentialNotice | undefined {
    const state = this.#state
    return state.memory === undefined ? undefined : state.notice
  }

  read(): Promise<string | undefined> {
    return this.#serial(() => this.#read())
  }

  write(text: string): Promise<void> {
    return this.#serial(() => this.#write(text))
  }

  /** Delete the sealed file, the key's entry and any in-memory copy. */
  clear(): Promise<void> {
    return this.#serial(() => this.#clear())
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run)
    this.#queue = next.catch(() => {})
    return next
  }

  /** Whether the store may be called now (it isn't failing or timed out). */
  #storeUsable(): boolean {
    const state = this.#state
    if (!state.unavailable) return true
    if (this.#now() < state.unavailable.retryAt) return false
    state.unavailable = undefined
    return true
  }

  /** One store call, bounded by the timeout; a failure or timeout is recorded. */
  async #call<T>(run: () => Promise<T>): Promise<T | typeof UNAVAILABLE> {
    if (!this.#storeUsable()) return UNAVAILABLE
    try {
      return await this.#withTimeout(run())
    } catch (error) {
      this.#markUnavailable(error)
      return UNAVAILABLE
    }
  }

  async #read(): Promise<string | undefined> {
    const state = this.#state
    // Newer than anything sealed: it couldn't be saved.
    if (state.memory !== undefined) return state.memory
    const sealed = await this.#readSealed()
    if (!sealed) return undefined
    const key = await this.#keyNamed(sealed.key)
    if (key === UNAVAILABLE) return undefined
    if (!key) {
      this.#options.logger?.warn(
        `The key for ${this.#options.file} is gone from the OS credential store; sign in again.`,
      )
      await this.#options.store.delete(this.#options.file)
      return undefined
    }
    try {
      const plain = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromBase64(sealed.iv),
          additionalData: additionalData(sealed.key),
        },
        key.key,
        fromBase64(sealed.data),
      )
      return new TextDecoder().decode(plain)
    } catch {
      this.#options.logger?.warn(
        `${this.#options.file} could not be decrypted; sign in again.`,
      )
      await this.#clear()
      return undefined
    }
  }

  async #write(text: string): Promise<void> {
    const state = this.#state
    const key = await this.#writeKey()
    if (!key) {
      // Kept in memory; the sealed file (if any) stays for a later start.
      state.memory = text
      state.notice ??= this.#unavailableNotice()
      return
    }
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: additionalData(key.name) },
      key.key,
      new TextEncoder().encode(text),
    )
    const sealed: SealedFile = {
      format: SEALED_FORMAT,
      alg: "A256GCM",
      key: key.name,
      iv: toBase64(iv),
      data: toBase64(new Uint8Array(data)),
    }
    await this.#options.store.writeText(
      this.#options.file,
      `${JSON.stringify(sealed)}\n`,
    )
    if (state.memory !== undefined) {
      state.memory = undefined
      state.notice = undefined
      this.#options.logger?.info(
        "The OS credential store works again; the sign-in is saved.",
      )
    }
  }

  /** The key to seal with: the current one, the sealed file's, or a new one. */
  async #writeKey(): Promise<Key | undefined> {
    if (this.#key) return this.#key
    if (!this.#storeUsable()) return undefined
    const sealed = await this.#readSealed()
    if (sealed) {
      const existing = await this.#keyNamed(sealed.key)
      if (existing === UNAVAILABLE) return undefined
      if (existing) return existing
    }
    const raw = crypto.getRandomValues(new Uint8Array(32))
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
      "hex",
    )
    const name = `${this.#options.keyName}/${id}`
    const stored = await this.#call(() =>
      this.#options.secrets.set(name, toBase64(raw)),
    )
    if (stored === UNAVAILABLE) return undefined
    this.#key = { name, key: await importKey(raw) }
    return this.#key
  }

  /** The key stored under `name`: `undefined` when there is no usable entry. */
  async #keyNamed(name: string): Promise<Key | undefined | typeof UNAVAILABLE> {
    if (this.#key?.name === name) return this.#key
    const value = await this.#call(() => this.#options.secrets.get(name))
    if (value === UNAVAILABLE) return UNAVAILABLE
    if (value === undefined) return undefined
    const raw = fromBase64(value)
    if (raw.length !== 32) {
      // Not a key of ours: remove it rather than leave it behind.
      await this.#forgetKey(name)
      return undefined
    }
    this.#key = { name, key: await importKey(raw) }
    return this.#key
  }

  async #readSealed(): Promise<SealedFile | undefined> {
    const text = await this.#options.store.readText(this.#options.file)
    if (text === undefined) return undefined
    const sealed = parseSealed(text)
    if (!sealed) {
      this.#options.logger?.warn(
        `${this.#options.file} is not a sealed cache; removing it.`,
      )
      await this.#options.store.delete(this.#options.file)
    }
    return sealed
  }

  async #clear(): Promise<void> {
    const { store, file } = this.#options
    const state = this.#state
    state.memory = undefined
    state.notice = undefined
    const names = new Set<string>()
    const text = await store.readText(file)
    const sealed = text === undefined ? undefined : parseSealed(text)
    if (sealed) names.add(sealed.key)
    if (this.#key) names.add(this.#key.name)
    this.#key = undefined
    await store.delete(file)
    for (const name of names) await this.#forgetKey(name)
  }

  /** Remove a key's entry, best effort: without its file it unlocks nothing. */
  async #forgetKey(name: string): Promise<void> {
    if (this.#state.timedOut) return
    try {
      await this.#withTimeout(this.#options.secrets.delete(name))
    } catch (error) {
      this.#options.logger?.debug(
        `Could not remove ${name} from the OS credential store: ${message(error)}`,
      )
    }
  }

  async #withTimeout<T>(promise: Promise<T>): Promise<T> {
    const timeoutMs = this.#options.timeoutMs ?? SECRET_STORE_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new StoreTimeoutError(`no answer in ${timeoutMs / 1000} s`))
          }, timeoutMs)
          // Never keeps the process alive on its own.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- absent on some timer implementations
          timer.unref?.()
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  #unavailableNotice(): CredentialNotice {
    return (
      this.#state.unavailable?.notice
      ?? memoryOnlyNotice(this.#options.platform ?? process.platform)
    )
  }

  #markUnavailable(error: unknown): void {
    const state = this.#state
    const timedOut = error instanceof StoreTimeoutError
    const notice = memoryOnlyNotice(this.#options.platform ?? process.platform)
    const first = !state.unavailable && !state.timedOut
    state.unavailable = {
      notice,
      retryAt:
        timedOut ?
          Number.POSITIVE_INFINITY
        : this.#now() + (this.#options.retryMs ?? SECRET_STORE_RETRY_MS),
    }
    if (timedOut && !state.timedOut) {
      state.timedOut = true
      this.#options.logger?.warn(
        `The OS credential store didn't answer (${message(error)}); keeping the sign-in in memory until Maximal restarts.`,
      )
      this.#options.onTimeout?.(notice)
      return
    }
    if (first)
      this.#options.logger?.warn(
        `The OS credential store is unavailable (${message(error)}); keeping the sign-in in memory and trying again later.`,
      )
  }
}

const UNAVAILABLE = Symbol("unavailable")
