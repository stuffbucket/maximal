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
  /** An older plaintext file: moved into the sealed file on first use, then deleted. */
  legacyFile?: string
  /** Entry name prefix in `secrets`; a random key id is appended. */
  keyName: string
  logger?: PluginLogger
  /** For the memory-only wording (default `process.platform`). */
  platform?: string
}

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
 * When the store can't be used (no Secret Service on Linux, access denied),
 * the text is kept in memory only, for this instance's lifetime, and never
 * written in plain text; `memoryOnly` says so. Operations run one at a time.
 */
export class SealedCache {
  readonly #options: SealedCacheOptions
  #queue: Promise<unknown> = Promise.resolve()
  #key: Key | undefined
  #migrated = false
  /** Set once the store failed: from then on `#memory` is the cache. */
  #unavailable: CredentialNotice | undefined
  #memory: string | undefined

  constructor(options: SealedCacheOptions) {
    this.#options = options
  }

  /** Set when the OS credential store can't be used and the text lives in memory only. */
  get memoryOnly(): CredentialNotice | undefined {
    return this.#unavailable
  }

  /** Move a plaintext legacy file into the sealed file (no-op without one). */
  migrate(): Promise<void> {
    return this.#serial(() => this.#migrate())
  }

  read(): Promise<string | undefined> {
    return this.#serial(async () => {
      await this.#migrate()
      return await this.#read()
    })
  }

  write(text: string): Promise<void> {
    return this.#serial(async () => {
      await this.#migrate()
      await this.#write(text)
    })
  }

  /** Delete the sealed file, any legacy file, and the key's entry. */
  clear(): Promise<void> {
    return this.#serial(() => this.#clear())
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run)
    this.#queue = next.catch(() => {})
    return next
  }

  async #migrate(): Promise<void> {
    const legacy = this.#options.legacyFile
    if (this.#migrated || legacy === undefined) return
    const { store, file } = this.#options
    const text = await store.readText(legacy)
    if (text !== undefined) {
      // A sealed file written since wins over the leftover plaintext.
      if ((await store.readText(file)) === undefined) await this.#write(text)
      await store.delete(legacy)
      this.#options.logger?.info(
        this.#unavailable ?
          `Removed the plaintext ${legacy}; the sign-in is kept in memory until Maximal restarts.`
        : `Moved the sign-in from the plaintext ${legacy} into the OS credential store.`,
      )
    }
    this.#migrated = true
  }

  async #read(): Promise<string | undefined> {
    if (this.#unavailable) return this.#memory
    const sealed = await this.#readSealed()
    if (!sealed) return undefined
    const key = await this.#keyNamed(sealed.key)
    if (key === "unavailable") return this.#memory
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
    const { store, file } = this.#options
    if (!this.#unavailable) {
      const key = await this.#writeKey()
      if (key) {
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
        await store.writeText(file, `${JSON.stringify(sealed)}\n`)
        return
      }
    }
    this.#memory = text
    // A sealed file from before would bring back an older sign-in later.
    await store.delete(file)
  }

  /** The key to seal with: the current one, the sealed file's, or a new one. */
  async #writeKey(): Promise<Key | undefined> {
    if (this.#key) return this.#key
    const sealed = await this.#readSealed()
    if (sealed) {
      const existing = await this.#keyNamed(sealed.key)
      if (existing === "unavailable") return undefined
      if (existing) return existing
    }
    const raw = crypto.getRandomValues(new Uint8Array(32))
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
      "hex",
    )
    const name = `${this.#options.keyName}/${id}`
    try {
      await this.#options.secrets.set(name, toBase64(raw))
    } catch (error) {
      this.#markUnavailable(error)
      return undefined
    }
    this.#key = { name, key: await importKey(raw) }
    return this.#key
  }

  /** The key stored under `name`: `undefined` when there is no such entry. */
  async #keyNamed(name: string): Promise<Key | undefined | "unavailable"> {
    if (this.#key?.name === name) return this.#key
    let value: string | undefined
    try {
      value = await this.#options.secrets.get(name)
    } catch (error) {
      this.#markUnavailable(error)
      return "unavailable"
    }
    if (value === undefined) return undefined
    const raw = fromBase64(value)
    if (raw.length !== 32) return undefined
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
    const { store, file, legacyFile, secrets } = this.#options
    this.#memory = undefined
    const names = new Set<string>()
    const text = await store.readText(file)
    const sealed = text === undefined ? undefined : parseSealed(text)
    if (sealed) names.add(sealed.key)
    if (this.#key) names.add(this.#key.name)
    this.#key = undefined
    await store.delete(file)
    if (legacyFile !== undefined) await store.delete(legacyFile)
    if (this.#unavailable) return
    for (const name of names) {
      try {
        await secrets.delete(name)
      } catch (error) {
        // The sealed file is gone, so the key alone unlocks nothing.
        this.#options.logger?.debug(
          `Could not remove ${name} from the OS credential store: ${message(error)}`,
        )
      }
    }
  }

  #markUnavailable(error: unknown): void {
    if (this.#unavailable) return
    this.#unavailable = memoryOnlyNotice(
      this.#options.platform ?? process.platform,
    )
    this.#options.logger?.warn(
      `The OS credential store is unavailable (${message(error)}); keeping the sign-in in memory until Maximal restarts.`,
    )
  }
}
