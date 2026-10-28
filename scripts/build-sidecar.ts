#!/usr/bin/env bun
// Compile Maximal's standalone binaries for the current host triple, dropping
// them under shell/src-tauri/binaries/ for Tauri's externalBin resolver.
//
// Each binary is skipped independently when it is newer than its watched
// sources. Override with --force or MAXIMAL_FORCE_SIDECAR=1; release pipelines
// should set the env so version metadata is always re-stamped.

import { spawnSync } from "node:child_process"
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

import {
  resolveSidecarChannel,
  resolveSidecarVersion,
} from "./build-sidecar-version"

interface BinaryBuild {
  args: Array<string>
  cwd: string
  label: string
  outfile: string
  watched: Array<string>
}

const REPO = resolve(import.meta.dir, "..")
const BROKER_PACKAGE = join(REPO, "packages/mcp-broker")
const FORCE =
  process.argv.includes("--force") || process.env.MAXIMAL_FORCE_SIDECAR === "1"

// `bun build --compile` writes its output to a hex-prefixed temp file
// (`.<hex>-<nnn>.bun-build`) in CWD before renaming to `--outfile`.
// Interrupted compiles leave those large files behind.
cleanBunBuildTemps(REPO)
cleanBunBuildTemps(BROKER_PACKAGE)
if (process.cwd() !== REPO && process.cwd() !== BROKER_PACKAGE) {
  cleanBunBuildTemps(process.cwd())
}

const triple = hostTriple()
const target = bunTarget(triple)
const executableSuffix = triple.includes("pc-windows") ? ".exe" : ""
const binaryDirectory = join(REPO, "shell/src-tauri/binaries")
const primaryOutfile = join(
  binaryDirectory,
  `maximal-${triple}${executableSuffix}`,
)
const brokerOutfile = join(
  binaryDirectory,
  `maximal-mcp-broker-${triple}${executableSuffix}`,
)

const sha = git(["rev-parse", "HEAD"])
const branch = git(["branch", "--show-current"])
const pkg = (await Bun.file(join(REPO, "package.json")).json()) as {
  version: string
}
const version = resolveSidecarVersion(
  pkg.version,
  sha,
  process.env.MAXIMAL_VERSION,
)
// The release channel this binary follows: MAXIMAL_CHANNEL if set, else the
// prerelease label of MAXIMAL_VERSION, else stable.
const channel = resolveSidecarChannel(
  process.env.MAXIMAL_VERSION,
  process.env.MAXIMAL_CHANNEL,
)

const builds: Array<BinaryBuild> = [
  {
    label: "primary",
    cwd: REPO,
    outfile: primaryOutfile,
    watched: [
      join(REPO, "src"),
      join(REPO, "package.json"),
      join(REPO, "bun.lock"),
    ],
    args: [
      "build",
      "--compile",
      `--target=${target}`,
      "--define",
      `__MAXIMAL_VERSION__="${version}"`,
      "--define",
      `__MAXIMAL_GIT_SHA__="${sha}"`,
      "--define",
      `__MAXIMAL_GIT_BRANCH__="${branch}"`,
      "--define",
      `__MAXIMAL_CHANNEL__="${channel}"`,
      join(REPO, "src/main.ts"),
      `--outfile=${primaryOutfile}`,
    ],
  },
  {
    label: "mcp-broker",
    cwd: BROKER_PACKAGE,
    outfile: brokerOutfile,
    watched: [
      join(BROKER_PACKAGE, "src"),
      join(BROKER_PACKAGE, "package.json"),
      join(BROKER_PACKAGE, "pnpm-lock.yaml"),
      join(BROKER_PACKAGE, "pnpm-workspace.yaml"),
      join(BROKER_PACKAGE, "patches"),
    ],
    args: [
      "build",
      "--compile",
      `--target=${target}`,
      join(BROKER_PACKAGE, "src/main.ts"),
      `--outfile=${brokerOutfile}`,
    ],
  },
]

mkdirSync(binaryDirectory, { recursive: true })

for (const build of builds) {
  if (!FORCE && isUpToDate(build.outfile, build.watched)) {
    console.error(`[build-sidecar] ${build.label} up to date: ${build.outfile}`)
    continue
  }

  console.error(
    `[build-sidecar] binary=${build.label} triple=${triple} target=${target}\n`
      + `[build-sidecar] out=${build.outfile}`
      + (build.label === "primary" ?
        `\n[build-sidecar] version=${version} branch=${branch} channel=${channel}`
      : ""),
  )

  // Spawn the same Bun via its absolute path rather than the bare name. On
  // Windows CI, setup-bun can add only a Git-Bash-form path that a child
  // process cannot resolve through the OS.
  const result = spawnSync(process.execPath, build.args, {
    cwd: build.cwd,
    stdio: "inherit",
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function hostTriple(): string {
  const result = spawnSync("rustc", ["-vV"], { encoding: "utf8" })
  if (result.status === 0) {
    const match = result.stdout.match(/^host:\s*(.+)$/m)
    if (match) return match[1].trim()
  }
  const arch =
    process.arch === "arm64" ? "aarch64"
    : process.arch === "x64" ? "x86_64"
    : process.arch
  const platform =
    process.platform === "darwin" ? "apple-darwin"
    : process.platform === "linux" ? "unknown-linux-gnu"
    : process.platform === "win32" ? "pc-windows-msvc"
    : process.platform
  return `${arch}-${platform}`
}

function bunTarget(triple: string): string {
  if (triple === "aarch64-apple-darwin") return "bun-darwin-arm64"
  if (triple === "x86_64-apple-darwin") return "bun-darwin-x64"
  if (triple.includes("pc-windows")) return "bun-windows-x64"
  if (triple === "aarch64-unknown-linux-gnu") return "bun-linux-arm64"
  if (triple === "x86_64-unknown-linux-gnu") return "bun-linux-x64"
  throw new Error(`Unknown host triple: ${triple}`)
}

function git(args: Array<string>): string {
  const result = spawnSync("git", args, { cwd: REPO, encoding: "utf8" })
  return result.status === 0 ? result.stdout.trim() : ""
}

/**
 * True when `outfile` exists and is newer than every watched source. Skips
 * node_modules, dist, and dot-directories. Any I/O error forces a rebuild.
 */
function isUpToDate(outfile: string, watched: Array<string>): boolean {
  let outputModifiedAt: number
  try {
    outputModifiedAt = statSync(outfile).mtimeMs
  } catch {
    return false
  }
  try {
    for (const candidate of watched) {
      if (newerThan(candidate, outputModifiedAt)) return false
    }
  } catch {
    return false
  }
  return true
}

function newerThan(path: string, threshold: number): boolean {
  const stats = statSync(path)
  if (stats.isFile()) return stats.mtimeMs > threshold
  if (!stats.isDirectory()) return false
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue
    if (entry.name === "node_modules" || entry.name === "dist") continue
    if (newerThan(join(path, entry.name), threshold)) return true
  }
  return false
}

/** Delete orphaned Bun compile temp files from interrupted builds. */
function cleanBunBuildTemps(dir: string): void {
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  const pattern = /^\.[0-9a-f]+-\d+\.bun-build$/
  for (const entry of entries) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue
    try {
      rmSync(join(dir, entry.name), { force: true })
      console.error(`[build-sidecar] removed orphan: ${entry.name}`)
    } catch {
      // Best-effort; ignore.
    }
  }
}
