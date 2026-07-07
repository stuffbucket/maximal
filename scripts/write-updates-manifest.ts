#!/usr/bin/env bun
/**
 * Write the schema-2 update manifest at RELEASE PUBLISH time — WITHOUT an
 * Astro rebuild (issue #220, phase 1 of the #218 umbrella; design in
 * docs/decisions/site-runtime-version-manifest.md).
 *
 * The manifest lives at the fixed, CDN-cached, no-auth Pages path
 *   https://stuffbucket.github.io/maximal/updates/manifest.json
 * whose source-of-truth file is `site/public/updates/manifest.json` (Astro
 * serves site/public/** verbatim). Two consumers read it at runtime:
 *   - the desktop updater (src/lib/update-check.ts), which reads ONLY
 *     `channels.<c>.version`; and
 *   - the marketing site, which reads `channels.stable.downloads`.
 *
 * WHY a dedicated release step (not just the build-time route):
 *   The build-time generator (site/src/pages/updates/manifest.json.ts) resolves
 *   `releases/latest` during SSG, which lags a fresh publish (the propagation
 *   race #187 band-aids). This step is fed the RELEASE'S OWN tag + assets, so
 *   the manifest names its own tag and is fresh-on-publish regardless of when
 *   the site next rebuilds. Both paths run (belt-and-suspenders) until phase 3.
 *
 * SINGLE SOURCE OF TRUTH: the per-channel JSON shape is produced by
 * `buildChannel` from site/src/lib/updates-manifest.ts — the SAME pure builder
 * the Astro route uses. This script only handles I/O + a READ-MODIFY-WRITE
 * merge so a `beta` publish updates only `channels.beta` and never clobbers
 * `channels.stable` (and vice-versa). The channel of a tag is classified the
 * same way release.yml's "Detect pre-release" step does.
 *
 * SECURITY INVARIANT (see updates-manifest.ts): `downloads` is BROWSER-ONLY.
 * This script writes it for the site; the desktop client must keep reading only
 * `version`. Do NOT wire the installer to `downloads.url`.
 *
 * Usage:
 *   # Regenerate from a published release's live assets (via `gh`):
 *   bun scripts/write-updates-manifest.ts --tag v0.4.39
 *
 *   # Point at a non-default manifest path / repo:
 *   bun scripts/write-updates-manifest.ts --tag v0.4.39 \
 *     --repo stuffbucket/maximal --out site/public/updates/manifest.json
 *
 * The release workflow calls this after `publish`, then commits the updated
 * file. This script performs NO git operations and runs NO Astro build.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

import {
  buildChannel,
  MANIFEST_SCHEMA_VERSION,
  type ChannelReleaseInput,
  type ManifestAsset,
  type ManifestChannel,
  type UpdateManifest,
} from "../site/src/lib/updates-manifest"

const DEFAULT_OUT = "site/public/updates/manifest.json"
const DEFAULT_REPO = "stuffbucket/maximal"

interface Args {
  tag: string
  repo: string
  out: string
}

function parseArgs(argv: Array<string>): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
  }
  const tag = (get("--tag") ?? process.env.GITHUB_REF_NAME ?? "").trim()
  const repo = (
    get("--repo") ??
    process.env.GITHUB_REPOSITORY ??
    DEFAULT_REPO
  ).trim()
  const out = get("--out") ?? DEFAULT_OUT
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/u.test(tag)) {
    throw new Error(
      `--tag must be a vX.Y.Z[-pre] release tag (got '${tag || "<empty>"}')`,
    )
  }
  return { tag, repo, out }
}

/**
 * Classify which manifest channel a tag belongs to. Mirrors release.yml's
 * "Detect pre-release" step and the desktop binary's `__MAXIMAL_CHANNEL__`
 * derivation: a plain `vX.Y.Z` is `stable`; `vX.Y.Z-<label>.N` is `<label>`
 * (e.g. `beta` from `v0.4.33-beta.1`). Keeping this in lockstep is what lets a
 * `beta` publish touch only `channels.beta`.
 */
export function channelForTag(tag: string): string {
  const dash = tag.indexOf("-")
  if (dash === -1) return "stable"
  const label = tag.slice(dash + 1).split(".")[0]
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/u.test(label)) {
    throw new Error(`Unsupported prerelease channel in tag: ${tag}`)
  }
  return label
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** A minimally-valid schema-2 channel: a version + tag + notes string. */
function isValidChannel(v: unknown): v is ManifestChannel {
  return (
    isRecord(v) &&
    typeof v.version === "string" &&
    typeof v.tag === "string" &&
    typeof v.notes === "string"
  )
}

/**
 * Read-modify-write merge: set (or replace) exactly one channel, preserving
 * every other channel byte-for-byte. Returns a fresh document with a bumped
 * `generated` timestamp. If `existing` is null/malformed/older-schema, start
 * from an empty schema-2 document (the merged channel is authoritative; other
 * channels are only preserved when they were already schema-2 shaped).
 */
export function mergeChannel(
  existing: unknown,
  channelName: string,
  channel: ManifestChannel,
  generated: string = new Date().toISOString(),
): UpdateManifest {
  const priorChannels =
    isRecord(existing) &&
    isRecord((existing as { channels?: unknown }).channels)
      ? (existing as { channels: Record<string, unknown> }).channels
      : {}

  const channels: Record<string, ManifestChannel> = {}
  // Preserve prior channels that still look like valid schema-2 entries. A
  // prior entry for THIS channel is dropped — the fresh release supersedes it.
  for (const [name, value] of Object.entries(priorChannels)) {
    if (name === channelName) continue
    if (isValidChannel(value)) channels[name] = value
  }
  channels[channelName] = channel

  return { schema: MANIFEST_SCHEMA_VERSION, generated, channels }
}

/** Serialize identically to the Astro route (2-space indent + trailing NL) so
 *  the two writers produce byte-identical documents for identical inputs. */
export function serializeManifest(manifest: UpdateManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** Fetch a published release's assets via `gh`, mapped to the manifest's
 *  minimal {name,url} shape. Uses `gh` (already authenticated in CI + locally)
 *  rather than an unauthenticated REST call to avoid the 60/hr/IP limit. */
function fetchReleaseAssets(tag: string, repo: string): ManifestAsset[] {
  const res = spawnSync(
    "gh",
    ["release", "view", tag, "--repo", repo, "--json", "assets"],
    { encoding: "utf8" },
  )
  if (res.status !== 0) {
    throw new Error(
      `gh release view ${tag} failed: ${res.stderr?.trim() || `exit ${res.status}`}`,
    )
  }
  const parsed = JSON.parse(res.stdout) as {
    assets?: Array<{ name?: unknown; url?: unknown }>
  }
  const assets: ManifestAsset[] = []
  for (const a of parsed.assets ?? []) {
    if (typeof a.name === "string" && typeof a.url === "string") {
      assets.push({ name: a.name, url: a.url })
    }
  }
  return assets
}

async function readExistingManifest(out: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(out, "utf8"))
  } catch {
    // Missing file or unparseable body: start clean. The merged channel is
    // authoritative; we only lose stale sibling channels, which the next
    // release for that channel restores.
    return null
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const channelName = channelForTag(args.tag)

  const assets = fetchReleaseAssets(args.tag, args.repo)
  const input: ChannelReleaseInput = { tag: args.tag, assets }
  const channel = buildChannel(input)

  const existing = await readExistingManifest(args.out)
  const manifest = mergeChannel(existing, channelName, channel)

  await fs.mkdir(path.dirname(args.out), { recursive: true })
  await fs.writeFile(args.out, serializeManifest(manifest))

  const preserved =
    Object.keys(manifest.channels)
      .filter((c) => c !== channelName)
      .join(", ") || "none"
  console.error(
    `wrote ${args.out}: channels.${channelName} → ${channel.version} ` +
      `(${Object.keys(channel.downloads ?? {}).length} downloads); ` +
      `preserved channels: ${preserved}`,
  )
  return 0
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err: Error) => {
      console.error(`write-updates-manifest: ${err.message}`)
      process.exit(1)
    },
  )
}
