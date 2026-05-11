#!/usr/bin/env bun
// Compile the maximal proxy as a standalone binary for the current host
// triple, dropping it at shell/src-tauri/binaries/maximal-<triple> for
// Tauri's externalBin resolver to pick up.

import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const REPO = resolve(import.meta.dir, "..")

const triple = hostTriple()
const target = bunTarget(triple)
const sha = git(["rev-parse", "HEAD"])
const branch = git(["branch", "--show-current"])
const pkg = (await Bun.file(join(REPO, "package.json")).json()) as {
  version: string
}
const version = `${pkg.version}-dev+${sha.slice(0, 8) || "unknown"}`
const outfile = join(REPO, "shell/src-tauri/binaries", `maximal-${triple}`)

console.error(
  `[build-sidecar] triple=${triple} target=${target}\n[build-sidecar] out=${outfile}\n[build-sidecar] version=${version} branch=${branch}`,
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
