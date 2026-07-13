/**
 * Schema-2 update manifest builder (site/src/lib/updates-manifest.ts).
 *
 * Guards the two invariants that make the schema bump safe:
 *   1. It is byte-compatible with the desktop client — `channels.stable.version`
 *      is a bare "x.y.z" the client's parseManifestVersion still reads.
 *   2. `downloads` is keyed by role and only carries slots that actually
 *      resolved, so a reader treats an absent slot as "coming soon".
 *
 * Lives under tests/ (root bun test root) but imports the site module by
 * relative path — the site has no test runner of its own.
 */

import { describe, expect, test } from "bun:test"

import {
  buildChannel,
  buildManifest,
  MANIFEST_SCHEMA_VERSION,
  resolveDownloads,
  type ManifestAsset,
} from "../site/src/lib/updates-manifest"

// The parseManifestVersion regex the shipped desktop client uses, inlined so
// this test proves schema-2 output stays readable without importing src/.
const CLIENT_VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u

const dmgArm: ManifestAsset = {
  name: "maximal-v0.4.39-darwin-arm64.dmg",
  url: "https://github.com/stuffbucket/maximal/releases/download/v0.4.39/maximal-v0.4.39-darwin-arm64.dmg",
}
const winSetup: ManifestAsset = {
  name: "maximal-v0.4.39-windows-x64-setup.exe",
  url: "https://github.com/stuffbucket/maximal/releases/download/v0.4.39/maximal-v0.4.39-windows-x64-setup.exe",
}

describe("resolveDownloads", () => {
  test("maps known assets to their role slots", () => {
    const downloads = resolveDownloads([dmgArm, winSetup])
    expect(downloads["macos-arm64-dmg"]).toEqual({
      name: dmgArm.name,
      url: dmgArm.url,
    })
    expect(downloads["windows-x64-setup"]).toEqual({
      name: winSetup.name,
      url: winSetup.url,
    })
  })

  test("omits slots with no matching asset", () => {
    const downloads = resolveDownloads([dmgArm])
    expect(downloads["macos-arm64-dmg"]).toBeDefined()
    expect(downloads["windows-x64-setup"]).toBeUndefined()
    expect(downloads["macos-x64-dmg"]).toBeUndefined()
  })

  test("prefers the arm64 dmg over a bare x64 dmg for the arm slot", () => {
    const x64: ManifestAsset = {
      name: "maximal-v0.4.39-darwin-x64.dmg",
      url: "https://example/x64.dmg",
    }
    const downloads = resolveDownloads([x64, dmgArm])
    expect(downloads["macos-arm64-dmg"]?.name).toBe(dmgArm.name)
    expect(downloads["macos-x64-dmg"]?.name).toBe(x64.name)
  })
})

describe("buildChannel", () => {
  test("strips the leading v, names its tag, links notes", () => {
    const channel = buildChannel({ tag: "v0.4.39", assets: [dmgArm] })
    expect(channel.version).toBe("0.4.39")
    expect(channel.tag).toBe("v0.4.39")
    expect(channel.notes).toBe(
      "https://github.com/stuffbucket/maximal/releases/tag/v0.4.39",
    )
  })

  test("keeps version readable by the shipped desktop client", () => {
    const channel = buildChannel({ tag: "v0.4.39", assets: [] })
    expect(CLIENT_VERSION_RE.test(channel.version)).toBe(true)
    // A prerelease tag round-trips too.
    const beta = buildChannel({ tag: "v0.5.0-beta.2", assets: [] })
    expect(CLIENT_VERSION_RE.test(beta.version)).toBe(true)
    expect(beta.version).toBe("0.5.0-beta.2")
  })

  test("omits downloads entirely when no asset resolves (pinned version)", () => {
    const channel = buildChannel({ tag: "v0.4.39", assets: [] })
    expect(channel.downloads).toBeUndefined()
  })
})

describe("buildManifest", () => {
  test("emits schema 2 with only the channels that have a release", () => {
    const manifest = buildManifest(
      {
        stable: { tag: "v0.4.39", assets: [dmgArm, winSetup] },
        beta: null,
      },
      "2026-07-06T12:00:00.000Z",
    )
    expect(manifest.schema).toBe(MANIFEST_SCHEMA_VERSION)
    expect(manifest.schema).toBe(2)
    expect(manifest.generated).toBe("2026-07-06T12:00:00.000Z")
    expect(Object.keys(manifest.channels)).toEqual(["stable"])
    expect(manifest.channels.stable.version).toBe("0.4.39")
    expect(manifest.channels.stable.downloads?.["windows-x64-setup"]?.url).toBe(
      winSetup.url,
    )
  })

  test("is byte-compatible with a schema-1 client reading channels.stable.version", () => {
    const manifest = buildManifest({
      stable: { tag: "v0.4.39", assets: [dmgArm] },
    })
    // Emulate the client: JSON round-trip, then read only the version.
    const parsed = structuredClone(manifest) as {
      channels: { stable?: { version?: unknown } }
    }
    const version = parsed.channels.stable?.version
    expect(typeof version).toBe("string")
    expect(CLIENT_VERSION_RE.test(String(version))).toBe(true)
  })

  test("includes beta as a first-class channel with the identical shape", () => {
    const manifest = buildManifest({
      stable: { tag: "v0.4.39", assets: [] },
      beta: { tag: "v0.5.0-beta.2", assets: [] },
    })
    expect(manifest.channels.beta.version).toBe("0.5.0-beta.2")
    expect(manifest.channels.beta.tag).toBe("v0.5.0-beta.2")
  })
})
