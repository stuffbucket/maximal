#!/usr/bin/env bun
/**
 * Drop rotating package-feed shard hosts from the pnpm lockfiles.
 *
 * Each pnpm package's `.pnpmfile.cjs` keeps them out of a lockfile as it's
 * written. This repairs one that arrives with them anyway (written before
 * the hook, or by a tool that skipped it), which a frozen install would
 * otherwise reject. See scripts/lockfile-shard-hosts.cjs for why.
 *
 *   bun scripts/strip-lockfile-hosts.ts          # repair in place
 *   bun scripts/strip-lockfile-hosts.ts --check  # exit 1 if any are recorded
 */

import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import shardHosts from "./lockfile-shard-hosts.cjs"

const { SHARD_HOST } = shardHosts as { SHARD_HOST: RegExp }

const ROOT = path.resolve(import.meta.dir, "..")
/** Every committed pnpm lockfile (one per isolated package). */
export const LOCKFILES = [
  "packages/mcp-broker/pnpm-lock.yaml",
  "packages/storybook/pnpm-lock.yaml",
]

/** `text` with shard-host `tarball:` entries removed, and how many. Only
 *  `resolution: {…}` lines are touched, so nothing else can match. */
export function stripShardHosts(text: string): { text: string; stripped: number } {
  let stripped = 0
  const lines = text.split("\n").map((line) => {
    if (!line.trimStart().startsWith("resolution: {")) return line
    const tarball = /, tarball: ([^,}]+)/u.exec(line)
    if (tarball === null || !SHARD_HOST.test(tarball[1])) return line
    stripped += 1
    return line.replace(tarball[0], "")
  })
  return { text: lines.join("\n"), stripped }
}

if (import.meta.main) {
  const check = process.argv.includes("--check")
  let pinned = 0
  for (const lockfile of LOCKFILES) {
    const file = path.join(ROOT, lockfile)
    const { text, stripped } = stripShardHosts(readFileSync(file, "utf8"))
    if (stripped === 0) {
      console.log(`${lockfile}: clean`)
      continue
    }
    pinned += stripped
    if (check) {
      console.error(`${lockfile}: records ${stripped} rotating shard-host URL(s)`)
    } else {
      writeFileSync(file, text)
      console.log(`${lockfile}: dropped ${stripped} shard-host URL(s)`)
    }
  }
  if (check && pinned > 0) {
    console.error(
      "Run `bun scripts/strip-lockfile-hosts.ts` and commit the lockfiles.",
    )
    process.exit(1)
  }
}
