/**
 * The sealed token cache against an in-memory credential store: never the
 * real Keychain, Credential Manager or Secret Service.
 */
import { describe, expect, test } from "bun:test"

import type { TextStore } from "../src/auth/token-provider"

import {
  memoryOnlyNotice,
  SealedCache,
  type SealedCacheOptions,
} from "../src/auth/sealed-cache"
import { osSecretStore, scopedSecretStore } from "../src/auth/secret-store"
import { memorySecretStore } from "../src/testing/secret-store"
import { rejection } from "./rejection"

const CACHE = JSON.stringify({
  RefreshToken: { one: { secret: "refresh-secret" } },
  AccessToken: { one: { secret: "access-secret" } },
})

function memoryStore(): TextStore & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    readText: (name) => Promise.resolve(files.get(name)),
    writeText: (name, text) => {
      files.set(name, text)
      return Promise.resolve()
    },
    delete: (name) => {
      files.delete(name)
      return Promise.resolve()
    },
  }
}

/**
 * A cache over `store`. Each call is its own process unless `options.scope`
 * is shared (a connector rebuilt within one run).
 */
function sealed(
  store: TextStore,
  secrets = memorySecretStore(),
  options: Partial<SealedCacheOptions> = {},
) {
  return new SealedCache({
    store,
    secrets,
    file: "cache.sealed.json",
    legacyFile: "cache.json",
    keyName: "cache",
    platform: "linux",
    scope: `test:${crypto.randomUUID()}`,
    ...options,
  })
}

describe("sealed cache", () => {
  test("round-trips through ciphertext on disk and a small key in the store", async () => {
    const store = memoryStore()
    const secrets = memorySecretStore()
    const cache = sealed(store, secrets)
    expect(await cache.read()).toBeUndefined()
    // Nothing to read: the credential store is not touched.
    expect(secrets.calls).toEqual([])

    await cache.write(CACHE)
    const onDisk = store.files.get("cache.sealed.json") ?? ""
    expect(onDisk).not.toContain("secret")
    const file = JSON.parse(onDisk) as Record<string, string>
    expect(file).toMatchObject({ format: "maximal-sealed/1", alg: "A256GCM" })
    const [[name, key]] = [...secrets.entries]
    expect(file.key).toBe(name)
    expect(name).toMatch(/^cache\/[0-9a-f]{32}$/)
    // 32 random bytes, base64: far below Credential Manager's 2560-byte cap.
    expect(key).toHaveLength(44)
    expect(await cache.read()).toBe(CACHE)

    // A later write reuses the key, with a fresh nonce.
    await cache.write(`${CACHE} `)
    const rewritten = JSON.parse(
      store.files.get("cache.sealed.json") ?? "",
    ) as Record<string, string>
    expect(rewritten.key).toBe(name)
    expect(rewritten.iv).not.toBe(file.iv)
    expect(secrets.calls.filter((call) => call.startsWith("set"))).toHaveLength(
      1,
    )

    // Next start: one key lookup, then reads come from the remembered key.
    secrets.calls.length = 0
    const restarted = sealed(store, secrets)
    expect(await restarted.read()).toBe(`${CACHE} `)
    expect(await restarted.read()).toBe(`${CACHE} `)
    expect(secrets.calls).toEqual([`get ${name}`])
    expect(restarted.memoryOnly).toBeUndefined()
  })

  test("moves a plaintext legacy file into the sealed file, then deletes it", async () => {
    const store = memoryStore()
    const secrets = memorySecretStore()
    store.files.set("cache.json", CACHE)
    const cache = sealed(store, secrets)
    await cache.migrate()
    expect(store.files.has("cache.json")).toBe(false)
    expect(store.files.get("cache.sealed.json")).not.toContain("secret")
    expect(secrets.entries.size).toBe(1)
    expect(await sealed(store, secrets).read()).toBe(CACHE)
  })

  test("a read migrates too; a sealed file already there wins over leftover plaintext", async () => {
    const store = memoryStore()
    const secrets = memorySecretStore()
    await sealed(store, secrets).write(CACHE)
    store.files.set("cache.json", "stale plaintext")
    expect(await sealed(store, secrets).read()).toBe(CACHE)
    expect(store.files.has("cache.json")).toBe(false)
    expect(secrets.entries.size).toBe(1)
  })

  test("clear removes the sealed file, any legacy file and the key", async () => {
    const store = memoryStore()
    const secrets = memorySecretStore()
    const cache = sealed(store, secrets)
    await cache.write(CACHE)
    store.files.set("cache.json", CACHE)
    await cache.clear()
    expect([...store.files.keys()]).toEqual([])
    expect(secrets.entries.size).toBe(0)
    expect(await cache.read()).toBeUndefined()
    // The next write starts a new key.
    await cache.write(CACHE)
    expect(secrets.entries.size).toBe(1)
  })

  test("a key missing from the store means signed out, and the useless file goes", async () => {
    const store = memoryStore()
    const secrets = memorySecretStore()
    await sealed(store, secrets).write(CACHE)
    secrets.entries.clear()
    expect(await sealed(store, secrets).read()).toBeUndefined()
    expect(store.files.has("cache.sealed.json")).toBe(false)
  })

  test("tampered ciphertext, a different key or a foreign file is never handed to MSAL", async () => {
    const store = memoryStore()
    const secrets = memorySecretStore()
    await sealed(store, secrets).write(CACHE)
    const file = JSON.parse(store.files.get("cache.sealed.json") ?? "") as {
      data: string
    }
    const bytes = Buffer.from(file.data, "base64")
    bytes[0] ^= 1
    store.files.set(
      "cache.sealed.json",
      JSON.stringify({ ...file, data: bytes.toString("base64") }),
    )
    expect(await sealed(store, secrets).read()).toBeUndefined()
    expect(store.files.has("cache.sealed.json")).toBe(false)
    expect(secrets.entries.size).toBe(0)

    store.files.set("cache.sealed.json", CACHE)
    expect(await sealed(store, secrets).read()).toBeUndefined()
    expect(store.files.has("cache.sealed.json")).toBe(false)
  })
})

describe("sealed cache when the store fails", () => {
  test("no credential store: memory only, nothing written, and the status says why", async () => {
    const store = memoryStore()
    const secrets = memorySecretStore({
      unavailable: new Error(
        "The name org.freedesktop.secrets was not provided",
      ),
    })
    const cache = sealed(store, secrets)
    await cache.write(CACHE)
    expect([...store.files.keys()]).toEqual([])
    expect(await cache.read()).toBe(CACHE)
    expect(cache.memoryOnly?.detail).toContain("gnome-keyring")
    expect(cache.memoryOnly?.detail).toContain("libsecret-1-0")
    // The next start has nothing: sign in again.
    expect(await sealed(store, secrets).read()).toBeUndefined()
    await cache.clear()
    expect(await cache.read()).toBeUndefined()
  })

  test("no credential store: a legacy plaintext file is kept for the next start, its sign-in in memory", async () => {
    const store = memoryStore()
    store.files.set("cache.json", CACHE)
    const secrets = memorySecretStore({ unavailable: new Error("no keyring") })
    const cache = sealed(store, secrets)
    expect(await cache.read()).toBe(CACHE)
    expect([...store.files.keys()]).toEqual(["cache.json"])
    expect(cache.memoryOnly).toBeDefined()

    // A later start with a working store moves it in after all.
    secrets.unavailable = undefined
    const next = sealed(store, secrets)
    expect(await next.read()).toBe(CACHE)
    expect([...store.files.keys()]).toEqual(["cache.sealed.json"])
  })

  test("a store that fails never costs the sealed sign-in", async () => {
    const store = memoryStore()
    const secrets = memorySecretStore()
    await sealed(store, secrets).write(CACHE)
    const sealedFile = store.files.get("cache.sealed.json")
    secrets.unavailable = new Error("keyring locked")
    const cache = sealed(store, secrets)
    // The keyring may be back next start: keep what is sealed.
    expect(await cache.read()).toBeUndefined()
    // A sign-in made now lives in memory, and the file stays as it was.
    await cache.write("new sign-in")
    expect(store.files.get("cache.sealed.json")).toBe(sealedFile)
    expect(await cache.read()).toBe("new sign-in")
    expect(cache.memoryOnly).toBeDefined()
  })

  test("a sign-in kept in memory survives the connector being rebuilt", async () => {
    const store = memoryStore()
    const secrets = memorySecretStore({ unavailable: new Error("no keyring") })
    const scope = `test:${crypto.randomUUID()}`
    await sealed(store, secrets, { scope }).write(CACHE)
    // Turned off and on: a new instance, same process.
    const rebuilt = sealed(store, secrets, { scope })
    expect(await rebuilt.read()).toBe(CACHE)
    expect(rebuilt.memoryOnly).toBeDefined()
    // Signing out forgets it for every instance.
    await rebuilt.clear()
    expect(await sealed(store, secrets, { scope }).read()).toBeUndefined()
  })

  test("a refused store is tried again later, and the sign-in is sealed once it works", async () => {
    const store = memoryStore()
    const secrets = memorySecretStore({ unavailable: new Error("locked") })
    let now = 0
    const cache = sealed(store, secrets, {
      retryMs: 1000,
      now: () => now,
    })
    await cache.write("first")
    expect(cache.memoryOnly).toBeDefined()
    secrets.unavailable = undefined
    // Not yet: no new store call before the retry time.
    const calls = secrets.calls.length
    await cache.write("second")
    expect(secrets.calls.length).toBe(calls)
    expect(store.files.has("cache.sealed.json")).toBe(false)
    now = 1000
    await cache.write("third")
    expect(cache.memoryOnly).toBeUndefined()
    expect(await sealed(store, secrets).read()).toBe("third")
  })

  test("a store that never answers times out once, says so, and isn't asked again", async () => {
    const store = memoryStore()
    const secrets = memorySecretStore({ stalled: true })
    const timeouts: Array<string> = []
    let now = 0
    const cache = sealed(store, secrets, {
      platform: "darwin",
      timeoutMs: 20,
      retryMs: 1000,
      now: () => now,
      onTimeout: (notice) => timeouts.push(notice.detail),
    })
    await cache.write(CACHE)
    expect(await cache.read()).toBe(CACHE)
    expect(cache.memoryOnly?.detail).toContain("macOS Keychain")
    expect(timeouts).toHaveLength(1)
    const calls = secrets.calls.length
    now = 10_000
    await cache.write("later")
    await cache.clear()
    expect(secrets.calls.length).toBe(calls)
    expect(timeouts).toHaveLength(1)
  })

  test("a value under the key's name that isn't a key is removed, not left behind", async () => {
    const store = memoryStore()
    const secrets = memorySecretStore()
    await sealed(store, secrets).write(CACHE)
    const [name] = [...secrets.entries.keys()]
    secrets.entries.set(name, "not-a-key")
    expect(await sealed(store, secrets).read()).toBeUndefined()
    expect(secrets.entries.has(name)).toBe(false)
  })

  test("operations run one at a time: concurrent first writes share one key", async () => {
    const store = memoryStore()
    const secrets = memorySecretStore()
    const cache = sealed(store, secrets)
    await Promise.all([cache.write("a"), cache.write("b"), cache.read()])
    expect(secrets.entries.size).toBe(1)
    expect(await cache.read()).toBe("b")
  })

  test("memory-only wording names each platform's store", () => {
    expect(memoryOnlyNotice("darwin").detail).toContain("macOS Keychain")
    expect(memoryOnlyNotice("win32").detail).toContain(
      "Windows Credential Manager",
    )
    expect(memoryOnlyNotice("linux").detail).toContain("Secret Service")
  })
})

describe("secret stores", () => {
  test("scoped entries carry the connector id", async () => {
    const secrets = memorySecretStore()
    const scoped = scopedSecretStore(secrets, "workiq")
    await scoped.set("key", "value")
    expect(await scoped.get("key")).toBe("value")
    expect([...secrets.entries.keys()]).toEqual(["workiq/key"])
    expect(await scoped.delete("key")).toBe(true)
  })

  test("the OS store refuses to run under bun test", async () => {
    expect(process.env.NODE_ENV).toBe("test")
    const error = await rejection(osSecretStore().get("anything"))
    expect((error as Error).message).toContain("not used under test")
  })
})
