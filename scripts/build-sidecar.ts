#!/usr/bin/env bun
// Compile the maximal proxy as a standalone binary for the current host
// triple, dropping it at shell/src-tauri/binaries/maximal-<triple> for
// Tauri's externalBin resolver to pick up.
//
// Skips the (slow, ~30–90s) compile when the existing binary is newer
// than every TypeScript source under src/ and package.json. Override
// with --force or MAXIMAL_FORCE_SIDECAR=1; release pipelines should
// set the env so version metadata is always re-stamped.

import { spawnSync } from "node:child_process"
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const REPO = resolve(import.meta.dir, "..")
const FORCE =
  process.argv.includes("--force") || process.env.MAXIMAL_FORCE_SIDECAR === "1"

// `bun build --compile` writes its output to a hex-prefixed temp file
// (`.<hex>-<nnn>.bun-build`) in CWD before renaming to `--outfile`.
// An interrupted compile leaves that temp behind — a 60+ MB Mach-O
// surprise in the repo root. Sweep both the repo root and the script's
// CWD on every run so they don't pile up across builds.
cleanBunBuildTemps(REPO)
if (process.cwd() !== REPO) cleanBunBuildTemps(process.cwd())

const triple = hostTriple()
const target = bunTarget(triple)
const outfile = join(REPO, "shell/src-tauri/binaries", `maximal-${triple}`)

if (!FORCE && isUpToDate(outfile)) {
  console.error(
    `[build-sidecar] up to date: ${outfile}\n`
      + `[build-sidecar] re-run with --force (or MAXIMAL_FORCE_SIDECAR=1) to rebuild`,
  )
  process.exit(0)
}

const sha = git(["rev-parse", "HEAD"])
const branch = git(["branch", "--show-current"])
const pkg = (await Bun.file(join(REPO, "package.json")).json()) as {
  version: string
}
const version = `${pkg.version}-dev+${sha.slice(0, 8) || "unknown"}`
// The release channel this binary follows; defaults to stable. Release
// pipelines (and `app:build:beta`) set MAXIMAL_CHANNEL to stamp the binary.
const channel = process.env.MAXIMAL_CHANNEL || "stable"

console.error(
  `[build-sidecar] triple=${triple} target=${target}\n[build-sidecar] out=${outfile}\n[build-sidecar] version=${version} branch=${branch} channel=${channel}`,
)

mkdirSync(dirname(outfile), { recursive: true })

const r = spawnSync(
  "bun",
  [
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
    `--outfile=${outfile}`,
  ],
  { cwd: REPO, stdio: "inherit" },
)
process.exit(r.status ?? 1)

function hostTriple(): string {
  const r = spawnSync("rustc", ["-vV"], { encoding: "utf8" })
  if (r.status === 0) {
    const m = r.stdout.match(/^host:\s*(.+)$/m)
    if (m) return m[1].trim()
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
  const r = spawnSync("git", args, { cwd: REPO, encoding: "utf8" })
  return r.status === 0 ? r.stdout.trim() : ""
}

/**
 * True when `outfile` exists and is newer than every regular file under
 * src/, package.json, and bun.lock. Skips node_modules / dist / dotdirs.
 * Returns false on any I/O error — better to rebuild than to ship stale.
 */
function isUpToDate(outfile: string): boolean {
  let outMtime: number
  try {
    outMtime = statSync(outfile).mtimeMs
  } catch {
    return false
  }
  const watched = [
    join(REPO, "src"),
    join(REPO, "package.json"),
    join(REPO, "bun.lock"),
  ]
  try {
    for (const p of watched) {
      if (newerThan(p, outMtime)) return false
    }
  } catch {
    return false
  }
  return true
}

function newerThan(path: string, threshold: number): boolean {
  const st = statSync(path)
  if (st.isFile()) {
    return st.mtimeMs > threshold
  }
  if (!st.isDirectory()) return false
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue
    if (entry.name === "node_modules" || entry.name === "dist") continue
    if (newerThan(join(path, entry.name), threshold)) return true
  }
  return false
}

/**
 * Delete any orphaned `.<hex>-<nnn>.bun-build` temp files from a previous
 * interrupted compile. The naming pattern is Bun's internal scratch file
 * format; we match it conservatively to avoid touching anything else.
 */
function cleanBunBuildTemps(dir: string): void {
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  const pattern = /^\.[0-9a-f]+-\d+\.bun-build$/
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!pattern.test(entry.name)) continue
    try {
      rmSync(join(dir, entry.name), { force: true })
      console.error(`[build-sidecar] removed orphan: ${entry.name}`)
    } catch {
      // Best-effort; ignore.
    }
  }
}
