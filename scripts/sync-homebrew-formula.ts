#!/usr/bin/env bun
/**
 * Render the Homebrew formula for a specific release.
 *
 * Reads `build/homebrew/maximal.rb` (the source-of-truth template
 * with PLACEHOLDER_* tokens) and substitutes:
 *
 *   PLACEHOLDER_ORG                  ← --org or `repo` env (`<owner>`)
 *   PLACEHOLDER_VERSION              ← --version (without leading `v`)
 *   PLACEHOLDER_SHA256_DARWIN_ARM64  ← from the release's
 *                                       <name>-darwin-arm64.tar.gz.sha256
 *
 * Apple Silicon only — no Intel macOS target.
 *
 * Output goes to stdout by default, or to --output if provided.
 *
 * Pure Bun script — no `gh` invocation, no GitHub Actions surface.
 * Fetches the .sha256 files via plain HTTPS so this runs anywhere
 * `bun` does, including inside the tap repo's update flow.
 *
 * Usage:
 *
 *   # Render for release v1.9.4 of <org>/maximal to stdout:
 *   bun scripts/sync-homebrew-formula.ts \
 *     --org microsoft-internal --repo maximal --version 1.9.4
 *
 *   # Write to a path (e.g. into a checkout of the tap repo):
 *   bun scripts/sync-homebrew-formula.ts \
 *     --org microsoft-internal --repo maximal --version 1.9.4 \
 *     --output ../homebrew-tap/Formula/maximal.rb
 *
 *   # Override the release-asset URL prefix (for testing against a
 *   # private mirror):
 *   bun scripts/sync-homebrew-formula.ts ... \
 *     --asset-base https://internal-mirror.example/maximal
 *
 * The tap repo's CI (or a release-time GH Actions step) calls this
 * with the just-published version, drops the rendered file into
 * Formula/, commits, and PRs. That handoff lives in the tap repo;
 * this script is only the renderer.
 */

import fs from "node:fs/promises"
import path from "node:path"

interface Args {
  org: string
  repo: string
  version: string
  template: string
  output: string | undefined
  assetBase: string | undefined
}

function parseArgs(argv: Array<string>): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
  }
  const org = get("--org") ?? process.env.GITHUB_ORG ?? ""
  const repo = get("--repo") ?? process.env.GITHUB_REPO ?? "maximal"
  const version = (get("--version") ?? "").replace(/^v/, "")
  const template =
    get("--template") ?? "build/homebrew/maximal.rb"
  const output = get("--output")
  const assetBase = get("--asset-base")

  if (!org) {
    throw new Error("--org (or GITHUB_ORG env) is required")
  }
  if (!version) {
    throw new Error("--version is required")
  }
  return { org, repo, version, template, output, assetBase }
}

function releaseAssetUrl(args: Args, assetName: string): string {
  if (args.assetBase) {
    return `${args.assetBase.replace(/\/+$/, "")}/${assetName}`
  }
  return (
    `https://github.com/${args.org}/${args.repo}` +
    `/releases/download/v${args.version}/${assetName}`
  )
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url)
  if (!r.ok) {
    throw new Error(`fetch ${url} → ${r.status} ${r.statusText}`)
  }
  return r.text()
}

/** Each `.sha256` file Stream A publishes contains a single line:
 *  "<64-hex>  <filename>". Extract the SHA. */
export function parseSha256File(content: string, expectFile: string): string {
  const line = content.trim().split("\n")[0]
  const m = line.match(/^([0-9a-f]{64})\s+(\S+)$/u)
  if (!m) {
    throw new Error(`malformed sha256 file: ${line}`)
  }
  if (path.basename(m[2]) !== path.basename(expectFile)) {
    throw new Error(
      `sha256 file references ${m[2]}, expected ${expectFile}`,
    )
  }
  return m[1]
}

async function fetchSha256(args: Args, asset: string): Promise<string> {
  const shaUrl = releaseAssetUrl(args, `${asset}.sha256`)
  const body = await fetchText(shaUrl)
  return parseSha256File(body, asset)
}

/** Apply placeholder substitution. Pure; testable without network. */
export function renderFormula(
  template: string,
  values: {
    org: string
    version: string
    armSha: string
  },
): string {
  return template
    .replaceAll("PLACEHOLDER_ORG", values.org)
    .replaceAll("PLACEHOLDER_VERSION", values.version)
    .replaceAll("PLACEHOLDER_SHA256_DARWIN_ARM64", values.armSha)
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))

  const armAsset = `maximal-v${args.version}-darwin-arm64.tar.gz`

  const [armSha, template] = await Promise.all([
    fetchSha256(args, armAsset),
    fs.readFile(args.template, "utf8"),
  ])

  const rendered = renderFormula(template, {
    org: args.org,
    version: args.version,
    armSha,
  })

  if (args.output) {
    await fs.writeFile(args.output, rendered)
    console.error(`wrote ${args.output}`)
  } else {
    process.stdout.write(rendered)
  }
  return 0
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err: Error) => {
      console.error(`sync-homebrew-formula: ${err.message}`)
      process.exit(1)
    },
  )
}
