/**
 * The sealed token cache against an in-memory credential store: never the
 * real Keychain, Credential Manager or Secret Service.
 */
import { describe, expect, test } from "bun:test"

import type { TextStore } from "../src/auth/token-provider"

import { memoryOnlyNotice, SealedCache } from "../src/auth/sealed-cache"
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

function sealed(
  store: TextStore,
  secrets = memorySecretStore(),
  platform = "linux",
) {
  return new SealedCache({
    store,
    secrets,
    file: "cache.sealed.json",
    legacyFile: "cache.json",
    keyName: "cache",
    platform,
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

  test("no credential store: a legacy plaintext file is deleted, its sign-in kept in memory", async () => {
    const store = memoryStore()
    store.files.set("cache.json", CACHE)
    const cache = sealed(
      store,
      memorySecretStore({ unavailable: new Error("no keyring") }),
    )
    expect(await cache.read()).toBe(CACHE)
    expect([...store.files.keys()]).toEqual([])
    expect(cache.memoryOnly).toBeDefined()
  })

  test("a store that goes away keeps the sealed file until a new sign-in replaces it", async () => {
    const store = memoryStore()
    const secrets = memorySecretStore()
    await sealed(store, secrets).write(CACHE)
    secrets.unavailable = new Error("keyring locked")
    const cache = sealed(store, secrets)
    // The keyring may be back next start: keep what is sealed.
    expect(await cache.read()).toBeUndefined()
    expect(store.files.has("cache.sealed.json")).toBe(true)
    // A sign-in now lives in memory; the old sealed one must not come back later.
    await cache.write("new sign-in")
    expect(store.files.has("cache.sealed.json")).toBe(false)
    expect(await cache.read()).toBe("new sign-in")
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
