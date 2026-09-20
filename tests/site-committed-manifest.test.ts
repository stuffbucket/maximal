/**
 * Contract-lock for the COMMITTED static update manifest
 * (site/public/updates/manifest.json) and the site's build-time resolver
 * (site/src/lib/version.ts), which as of #223 (Phase 4 of #218) reads that file
 * instead of the GitHub API.
 *
 * Why this test exists: the committed manifest is now the single build-time
 * source of truth for BOTH
 *   1. the desktop app's upgrade check (src/lib/update-check.ts →
 *      parseManifestVersion, which reads channels.<c>.version), and
 *   2. the marketing site's server-rendered download fallback (version.ts →
 *      downloads.ts) AND its runtime hydration (hydrate-manifest.ts →
 *      readStableDownloads).
 * A hand-edit that breaks the schema would silently regress the app upgrade
 * banner and/or the site's fail-closed fallback. This locks both consumers
 * against the actual committed bytes.
 *
 * Lives under tests/ (root bun test root); imports site modules + the app
 * updater by relative path.
 */

import { describe, expect, test } from "bun:test"

import committedManifestJson from "../site/public/updates/manifest.json"
import { readStableDownloads } from "../site/src/lib/hydrate-manifest"
import {
  MANIFEST_SCHEMA_VERSION,
  type UpdateManifest,
} from "../site/src/lib/updates-manifest"
import {
  resolveLatestPrerelease,
  resolveLatestRelease,
} from "../site/src/lib/version"
import { parseManifestVersion } from "../src/lib/update/update-check"

// Widen the imported JSON literal to the declared contract type so channel
// lookups (e.g. the optional `beta`) type-check against the schema, not the
// exact committed shape.
const manifest = committedManifestJson as UpdateManifest
const RAW = JSON.stringify(manifest)
const stable = manifest.channels.stable

describe("committed static update manifest", () => {
  test("is a schema-2 document with a stable channel", () => {
    expect(manifest.schema).toBe(MANIFEST_SCHEMA_VERSION)
    expect(stable).toBeDefined()
  })

  test("satisfies the DESKTOP updater's parseManifestVersion (app upgrade path)", () => {
    // The app reads ONLY channels.stable.version; a clean X.Y.Z must parse so
    // the update banner can compare against the running build.
    const version = parseManifestVersion(RAW, "stable")
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/)
    // And it must equal the channel's own `version` field (no leading v).
    expect(version).toBe(stable.version)
  })

  test("satisfies the SITE's runtime hydration reader (readStableDownloads)", () => {
    const data = readStableDownloads(manifest)
    expect(data).not.toBeNull()
    expect(data?.versionLabel).toBe(stable.tag)
    // A real macOS download URL must resolve (the primary CTA).
    expect(data?.macDmg).toMatch(/^https:\/\/.*\.dmg$/)
  })
})

describe("version.ts resolves from the committed manifest (no GitHub API)", () => {
  test("resolveLatestRelease returns the committed stable tag + assets", () => {
    const info = resolveLatestRelease()
    expect(info.hasRelease).toBe(true)
    expect(info.tag).toBe(stable.tag)
    // Assets are flattened from the channel's downloads map: the macOS .dmg and
    // the Windows setup.exe the SSR fallback bakes must be present.
    const names = info.assets.map((a) => a.name)
    expect(names.some((n) => /\.dmg$/.test(n))).toBe(true)
    expect(names.some((n) => /-setup\.exe$/.test(n))).toBe(true)
    // Every asset carries a concrete URL (no empty/broken links baked into SSR).
    for (const a of info.assets) expect(a.url).toMatch(/^https:\/\//)
  })

  test("resolveLatestPrerelease is empty when the manifest has no beta channel", () => {
    // The committed seed carries only `stable`; beta resolves to "no release"
    // (same shape the old empty-list result produced). Guard the premise so
    // this stays meaningful if a beta is ever seeded.
    const hasBeta = Object.hasOwn(manifest.channels, "beta")
    const info = resolveLatestPrerelease()
    if (hasBeta) {
      expect(info.hasRelease).toBe(true)
    } else {
      expect(info.hasRelease).toBe(false)
      expect(info.tag).toBeNull()
      expect(info.assets).toEqual([])
    }
  })
})
