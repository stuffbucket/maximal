/**
 * Runtime manifest hydration parser (site/src/lib/hydrate-manifest.ts).
 *
 * The browser reads channels.stable at runtime to upgrade the download buttons
 * (issue #221). These guard the fail-closed contract: a trustworthy schema-2
 * document yields the stable channel's version + per-slot download URLs, while
 * anything unexpected (wrong schema, missing channel, garbage) yields null so
 * the caller keeps the server-rendered fallback.
 *
 * Lives under tests/ (root bun test root) and imports the site module by
 * relative path — the site has no test runner of its own.
 */

import { describe, expect, test } from "bun:test"

import {
  parseManifest,
  readStableDownloads,
  type HydratedDownloads,
} from "../site/src/lib/hydrate-manifest"
import { buildManifest } from "../site/src/lib/updates-manifest"

const dmgArm = {
  name: "maximal-v0.4.39-darwin-arm64.dmg",
  url: "https://github.com/stuffbucket/maximal/releases/download/v0.4.39/maximal-v0.4.39-darwin-arm64.dmg",
}
const winSetup = {
  name: "maximal-v0.4.39-windows-x64-setup.exe",
  url: "https://github.com/stuffbucket/maximal/releases/download/v0.4.39/maximal-v0.4.39-windows-x64-setup.exe",
}

// A realistic, in-contract document (reuses the same pure builder the release
// writer + build-time route use, so the test tracks the real schema).
const goodManifest = buildManifest(
  { stable: { tag: "v0.4.39", assets: [dmgArm, winSetup] } },
  "2026-07-06T12:00:00.000Z",
)

/** Assert the parser returned data (not the fail-closed null) and narrow it. */
function expectHydrated(value: unknown): HydratedDownloads {
  const data = readStableDownloads(value)
  expect(data).not.toBeNull()
  return data as HydratedDownloads
}

describe("parseManifest", () => {
  test("accepts a schema-2 document with a channels map", () => {
    expect(parseManifest(goodManifest)).not.toBeNull()
  })

  test.each([
    ["null", null],
    ["a string", "nope"],
    ["a number", 2],
    ["an array", [1, 2, 3]],
    ["a wrong schema", { schema: 1, channels: {} }],
    ["a missing schema", { channels: {} }],
    ["a non-object channels", { schema: 2, channels: "x" }],
    ["a null channels", { schema: 2, channels: null }],
  ])("rejects %s", (_label, value) => {
    expect(parseManifest(value)).toBeNull()
  })
})

describe("readStableDownloads", () => {
  test("reads version + both platform URLs from the stable channel", () => {
    const data = expectHydrated(goodManifest)
    expect(data.versionLabel).toBe("v0.4.39")
    expect(data.macDmg).toBe(dmgArm.url)
    expect(data.winSetup).toBe(winSetup.url)
    expect(data.hasWindows).toBe(true)
  })

  test("prefers the channel tag for the version pill", () => {
    const m = buildManifest({ stable: { tag: "v1.2.3", assets: [dmgArm] } })
    expect(expectHydrated(m).versionLabel).toBe("v1.2.3")
  })

  test("falls back to the x64 dmg for the mac slot when no arm64 dmg is present", () => {
    const x64 = {
      name: "maximal-v0.4.39-darwin-x64.dmg",
      url: "https://example/x64.dmg",
    }
    const m = buildManifest({ stable: { tag: "v0.4.39", assets: [x64] } })
    expect(expectHydrated(m).macDmg).toBe(x64.url)
  })

  test("reports no Windows (⇒ coming soon) when no Windows slot resolved", () => {
    const m = buildManifest({ stable: { tag: "v0.4.39", assets: [dmgArm] } })
    const data = expectHydrated(m)
    expect(data.hasWindows).toBe(false)
    expect(data.winSetup).toBeNull()
    expect(data.macDmg).toBe(dmgArm.url)
  })

  test("leaves mac null (⇒ keep baked fallback) when no download slot resolved", () => {
    // A pinned version carries no assets, so buildChannel omits downloads.
    const m = buildManifest({ stable: { tag: "v0.4.39", assets: [] } })
    const data = expectHydrated(m)
    expect(data.versionLabel).toBe("v0.4.39")
    expect(data.macDmg).toBeNull()
    expect(data.winSetup).toBeNull()
    expect(data.hasWindows).toBe(false)
  })

  test("returns null when the stable channel is absent", () => {
    const m = buildManifest({ beta: { tag: "v0.5.0-beta.1", assets: [] } })
    expect(readStableDownloads(m)).toBeNull()
  })

  test("returns null (⇒ keep fallback) for an untrusted document", () => {
    expect(readStableDownloads(null)).toBeNull()
    expect(readStableDownloads({ schema: 1 })).toBeNull()
    expect(readStableDownloads("garbage")).toBeNull()
  })

  test("ignores a malformed download entry rather than emitting a broken link", () => {
    const m = {
      schema: 2,
      generated: "2026-07-06T12:00:00.000Z",
      channels: {
        stable: {
          version: "0.4.39",
          tag: "v0.4.39",
          notes: "x",
          downloads: {
            // url missing ⇒ not a usable download; slot is skipped.
            "macos-arm64-dmg": { name: "x.dmg" },
            "windows-x64-setup": winSetup,
          },
        },
      },
    }
    const data = expectHydrated(m)
    expect(data.macDmg).toBeNull()
    expect(data.winSetup).toBe(winSetup.url)
    expect(data.hasWindows).toBe(true)
  })
})
