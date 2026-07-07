/**
 * Publish-time update-manifest writer (scripts/write-updates-manifest.ts).
 *
 * Guards the invariants that make the release-workflow write step safe:
 *   1. Byte-parity with the Astro route: for the SAME inputs, the script's
 *      serialize(mergeChannel(...)) is identical to the route's
 *      serialize(buildManifest(...)) — one source of truth, two writers.
 *   2. Read-modify-write: a `beta` publish updates only `channels.beta` and
 *      never clobbers `channels.stable` (and vice-versa).
 *   3. Channel classification mirrors release.yml's "Detect pre-release" step.
 *
 * Lives under tests/ (root bun test root); imports the script + the shared site
 * builder by relative path (neither has a test runner of its own).
 */

import { describe, expect, test } from "bun:test"

import {
  channelForTag,
  mergeChannel,
  serializeManifest,
} from "../scripts/write-updates-manifest"
import {
  buildManifest,
  type ManifestAsset,
} from "../site/src/lib/updates-manifest"

// Same serialization the Astro route (site/src/pages/updates/manifest.json.ts)
// uses, inlined so this test proves parity without importing the .astro route.
const routeSerialize = (m: unknown): string => `${JSON.stringify(m, null, 2)}\n`

const dmgArm: ManifestAsset = {
  name: "maximal-v0.4.39-darwin-arm64.dmg",
  url: "https://github.com/stuffbucket/maximal/releases/download/v0.4.39/maximal-v0.4.39-darwin-arm64.dmg",
}
const winSetup: ManifestAsset = {
  name: "maximal-v0.4.39-windows-x64-setup.exe",
  url: "https://github.com/stuffbucket/maximal/releases/download/v0.4.39/maximal-v0.4.39-windows-x64-setup.exe",
}

const GEN = "2026-07-06T12:00:00.000Z"

describe("channelForTag", () => {
  test("a plain vX.Y.Z is the stable channel", () => {
    expect(channelForTag("v0.4.39")).toBe("stable")
  })

  test("a prerelease tag names its label channel (mirrors release.yml)", () => {
    expect(channelForTag("v0.5.0-beta.2")).toBe("beta")
    expect(channelForTag("v0.5.0-rc.1")).toBe("rc")
    expect(channelForTag("v0.5.0-nightly.20260706")).toBe("nightly")
  })

  test("rejects an unsupported prerelease label", () => {
    expect(() => channelForTag("v0.5.0-.1")).toThrow(/Unsupported/u)
  })
})

describe("mergeChannel byte-parity with the Astro route", () => {
  test("a single fresh stable channel is byte-identical to buildManifest", () => {
    const input = { tag: "v0.4.39", assets: [dmgArm, winSetup] }
    // Route: build the whole document from resolved releases.
    const routeDoc = buildManifest({ stable: input, beta: null }, GEN)
    // Script: merge the same channel into an empty document.
    const scriptChannel = buildManifest({ stable: input }, GEN).channels.stable
    const scriptDoc = mergeChannel(null, "stable", scriptChannel, GEN)
    expect(serializeManifest(scriptDoc)).toBe(routeSerialize(routeDoc))
  })
})

describe("mergeChannel read-modify-write", () => {
  test("updating beta preserves an existing stable channel byte-for-byte", () => {
    const priorStable = buildManifest(
      { stable: { tag: "v0.4.39", assets: [dmgArm] } },
      "2026-07-01T00:00:00.000Z",
    )
    const betaChannel = buildManifest({
      beta: { tag: "v0.5.0-beta.2", assets: [] },
    }).channels.beta

    const merged = mergeChannel(priorStable, "beta", betaChannel, GEN)

    // stable is carried over untouched…
    expect(merged.channels.stable).toEqual(priorStable.channels.stable)
    // …and beta is added.
    expect(merged.channels.beta.version).toBe("0.5.0-beta.2")
    expect(Object.keys(merged.channels).sort()).toEqual(["beta", "stable"])
    expect(merged.generated).toBe(GEN)
  })

  test("re-publishing the same channel replaces its prior entry", () => {
    const prior = buildManifest({
      stable: { tag: "v0.4.38", assets: [] },
    })
    const fresh = buildManifest({
      stable: { tag: "v0.4.39", assets: [dmgArm] },
    }).channels.stable

    const merged = mergeChannel(prior, "stable", fresh, GEN)
    expect(merged.channels.stable.version).toBe("0.4.39")
    expect(merged.channels.stable.tag).toBe("v0.4.39")
    expect(Object.keys(merged.channels)).toEqual(["stable"])
  })

  test("starts clean when the existing document is missing or malformed", () => {
    const fresh = buildManifest({
      stable: { tag: "v0.4.39", assets: [] },
    }).channels.stable

    for (const bad of [null, undefined, "not json", 42, { channels: 7 }]) {
      const merged = mergeChannel(bad, "stable", fresh, GEN)
      expect(merged.schema).toBe(2)
      expect(Object.keys(merged.channels)).toEqual(["stable"])
    }
  })

  test("drops a prior channel that is not schema-2 shaped", () => {
    const prior = {
      schema: 2,
      generated: GEN,
      channels: { stable: { version: "0.4.39" } }, // missing tag + notes
    }
    const beta = buildManifest({
      beta: { tag: "v0.5.0-beta.2", assets: [] },
    }).channels.beta
    const merged = mergeChannel(prior, "beta", beta, GEN)
    // The malformed stable entry is not carried over.
    expect(Object.keys(merged.channels)).toEqual(["beta"])
  })
})
