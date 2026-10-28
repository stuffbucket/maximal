#!/usr/bin/env bun
/**
 * Decide what goes into the apt repository at https://mxml.sh/apt, from the
 * updates manifest the same Pages deploy publishes.
 *
 * The apps learn about a release from `site/public/updates/manifest.json`; apt
 * installs from the repository built next to it. Building each suite from the
 * tag the manifest's matching channel names (`stable` -> channels.stable.tag,
 * `rc` -> channels.rc.tag) means the two can't disagree: a Linux build is never
 * told about a version apt can't install yet.
 *
 * For each suite the release must carry all four packages
 * (`maximal_<ver>_<arch>.deb`, `maximal-desktop_<ver>_<arch>.deb`, amd64 and
 * arm64). A release with none of them predates the Linux packages and its suite
 * is skipped with a notice, unless the manifest lists Linux downloads for that
 * tag: then the deploy fails, because apt would lag what the apps announce.
 *
 * Usage (deploy-pages.yml):
 *   bun scripts/apt-repo-plan.ts --manifest site/public/updates/manifest.json \
 *     --repo stuffbucket/maximal --out apt-plan.json
 *
 * Reads each release's asset names with `gh` (GH_TOKEN). Writes the plan as
 * JSON for build/linux/apt-repo.sh; prints notices and errors as workflow
 * annotations; exits 1 on any error.
 */

import { spawnSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { z } from "zod"

/** Apt suites, each named after the manifest channel it is built from. */
export const APT_SUITES = ["stable", "rc"] as const
export type AptSuite = (typeof APT_SUITES)[number]

export const LINUX_ARCHES = ["amd64", "arm64"] as const
const PACKAGES = ["maximal", "maximal-desktop"] as const

const TAG_RE = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/u

const Manifest = z.object({
  channels: z.record(
    z.string(),
    z.object({
      tag: z.string(),
      downloads: z
        .record(z.string(), z.object({ name: z.string() }))
        .optional(),
    }),
  ),
})

export interface SuitePlan {
  suite: AptSuite
  tag: string
  /** Release asset names of the suite's packages. */
  debs: Array<string>
}

export interface AptPlan {
  suites: Array<SuitePlan>
  notices: Array<string>
  errors: Array<string>
}

/** The four package files a release built from `tag` carries. */
export function expectedDebs(tag: string): Array<string> {
  const version = TAG_RE.exec(tag)?.[1]
  if (!version) return []
  return PACKAGES.flatMap((pkg) =>
    LINUX_ARCHES.map((arch) => `${pkg}_${version}_${arch}.deb`),
  )
}

/**
 * Plan the repository from the manifest and each named release's asset
 * names. Pure: the caller fetches. `assetsByTag` holds the tags the manifest
 * names; a missing entry means the release couldn't be read.
 */
export function planAptRepo(
  manifest: unknown,
  assetsByTag: Readonly<Record<string, ReadonlyArray<string>>>,
): AptPlan {
  const plan: AptPlan = { suites: [], notices: [], errors: [] }
  const parsed = Manifest.safeParse(manifest)
  if (!parsed.success) {
    plan.errors.push("The updates manifest isn't readable.")
    return plan
  }

  for (const suite of APT_SUITES) {
    const channel = parsed.data.channels[suite]
    if (!channel) {
      plan.notices.push(`No ${suite} release in the manifest; skipping the ${suite} suite.`)
      continue
    }
    const { tag } = channel
    const expected = expectedDebs(tag)
    if (expected.length === 0) {
      plan.errors.push(`channels.${suite}.tag "${tag}" isn't a release tag.`)
      continue
    }
    const listed = Object.entries(channel.downloads ?? {})
      .filter(([slot]) => slot.startsWith("linux-"))
      .map(([, download]) => download.name)
    const assets = assetsByTag[tag]
    if (!assets) {
      plan.errors.push(`Couldn't read the assets of ${tag}.`)
      continue
    }
    const present = expected.filter((name) => assets.includes(name))

    if (present.length === 0) {
      if (listed.length > 0) {
        plan.errors.push(
          `The manifest lists Linux packages for ${tag} (${suite}), but the release has none.`,
        )
      } else {
        plan.notices.push(
          `${tag} predates the Linux packages; skipping the ${suite} suite.`,
        )
      }
      continue
    }

    const missing = expected.filter((name) => !present.includes(name))
    if (missing.length > 0) {
      plan.errors.push(`${tag} (${suite}) is missing ${missing.join(", ")}.`)
      continue
    }
    const unknown = listed.filter((name) => !expected.includes(name))
    if (unknown.length > 0) {
      plan.errors.push(
        `The manifest's ${suite} channel lists ${unknown.join(", ")}, which ${tag} doesn't build.`,
      )
      continue
    }
    plan.suites.push({ suite, tag, debs: expected })
  }
  return plan
}

function releaseAssetNames(tag: string, repo: string): Array<string> | null {
  const res = spawnSync(
    "gh",
    ["release", "view", tag, "--repo", repo, "--json", "assets"],
    { encoding: "utf8" },
  )
  if (res.status !== 0) {
    console.error(`gh release view ${tag}: ${res.stderr.trim()}`)
    return null
  }
  const parsed = z
    .object({ assets: z.array(z.object({ name: z.string() })) })
    .safeParse(JSON.parse(res.stdout))
  return parsed.success ? parsed.data.assets.map((a) => a.name) : null
}

function arg(argv: Array<string>, flag: string, fallback?: string): string {
  const i = argv.indexOf(flag)
  const value = i >= 0 ? argv[i + 1] : fallback
  if (!value) throw new Error(`${flag} is required`)
  return value
}

async function main(argv: Array<string>): Promise<number> {
  const manifestPath = arg(argv, "--manifest", "site/public/updates/manifest.json")
  const repo = arg(argv, "--repo", process.env.GITHUB_REPOSITORY)
  const out = arg(argv, "--out")

  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"))
  const tags = new Set<string>()
  const channels = Manifest.safeParse(manifest)
  if (channels.success) {
    for (const suite of APT_SUITES) {
      const tag = channels.data.channels[suite]?.tag
      if (tag) tags.add(tag)
    }
  }
  const assetsByTag: Record<string, Array<string>> = {}
  for (const tag of tags) {
    const names = releaseAssetNames(tag, repo)
    if (names) assetsByTag[tag] = names
  }

  const plan = planAptRepo(manifest, assetsByTag)
  for (const notice of plan.notices) console.log(`::notice::${notice}`)
  for (const error of plan.errors) console.log(`::error::${error}`)
  await writeFile(out, `${JSON.stringify(plan, null, 2)}\n`)
  for (const suite of plan.suites) {
    console.log(`${suite.suite}: ${suite.tag} (${suite.debs.length} packages)`)
  }
  return plan.errors.length > 0 ? 1 : 0
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}
