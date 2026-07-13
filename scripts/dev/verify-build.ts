#!/usr/bin/env bun
/**
 * verify-build.ts — "build-readiness" check. Confirms the proxy CURRENTLY
 * running on a host was built from the commit you intend to test, and that the
 * config flags a live test needs are set. Bridges the gap between "merged to
 * main" and "in the running sidecar binary" — there is no automatic link, and
 * a stale `app:dev` build silently omits everything merged since it was built.
 *
 * How the running commit is known: the sidecar embeds
 * `${pkg.version}-dev+${sha.slice(0,8)}` as `BUILD_VERSION` at compile time via
 * `bun build --compile --define __MAXIMAL_VERSION__=...` (see
 * scripts/build-sidecar.ts). The proxy echoes it on every response as the
 * `x-maximal-version` header (src/server.ts). So the header's `+<sha>` suffix
 * IS the source commit the binary was built from — that is exactly what we
 * compare against origin/main.
 *
 * What it reports:
 *   - PASS  : running build sha == origin/main  (nothing merged is missing)
 *   - STALE : running sha is an ancestor of origin/main, N commits behind —
 *             rebuild needed (`bun run app:dev`)
 *   - AHEAD : running sha is ahead of / diverged from origin/main (local work
 *             or origin/main not fetched) — informational
 *   - UNKNOWN: header/sha unparseable, or origin/main not resolvable
 * Plus a config check: is `promptCacheRetention` set to "24h" (needed to test
 * #252 /responses prefix-cache retention end-to-end)?
 *
 * The number-crunching (sha parse, verdict) is pure and exported for tests;
 * the live I/O (one version-header fetch, one git call, one config-file read)
 * is thin. No mock.module anywhere (ADR-0011) — deps are injected.
 *
 * Usage:
 *   bun run verify:build                       # against http://127.0.0.1:4141
 *   bun run verify:build -- --base-url http://127.0.0.1:4142
 *   MAXIMAL_BASE_URL=http://127.0.0.1:4142 bun run verify:build
 *
 * Exit codes: 0 PASS, 1 STALE/UNKNOWN, 2 proxy unreachable.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DEFAULT_BASE_URL = "http://127.0.0.1:4141"

// ────────────────────────────────────────────────────────────────────
// Pure logic (exported for tests)
// ────────────────────────────────────────────────────────────────────

/**
 * Extract the embedded git sha from an `x-maximal-version` header value.
 * Format is `<semver>-dev+<sha8>` for host `app:dev` builds (see
 * scripts/build-sidecar.ts). Release binaries omit the `+<sha>` suffix, so a
 * missing suffix yields `null` (we can't map that to a commit). The returned
 * sha is whatever length was embedded (8 chars in dev), lower-cased.
 */
export function extractSha(versionHeader: string | null | undefined): string | null {
  if (typeof versionHeader !== "string") return null
  const match = versionHeader.match(/\+([0-9a-fA-F]{4,40})\b/)
  if (!match) return null
  return match[1].toLowerCase()
}

export type BuildVerdict = "PASS" | "STALE" | "AHEAD" | "UNKNOWN"

export interface ShaComparison {
  /** Whether the running sha is an ancestor of origin/main. */
  isAncestor: boolean
  /** Commits on origin/main not in the running build (how far behind). */
  behind: number
}

export interface VerdictInput {
  runningSha: string | null
  /** `git rev-parse --short origin/main`, or null if origin/main is unresolvable. */
  originSha: string | null
  /** Result of comparing runningSha against origin/main; null when either sha
   *  is missing or the comparison couldn't run (e.g. sha not in the object DB). */
  comparison: ShaComparison | null
}

export interface Verdict {
  verdict: BuildVerdict
  message: string
}

/** True when `a` is a prefix of `b` or vice-versa (both lower-cased hex). Lets
 *  us treat an 8-char embedded sha and a 7-char `--short` origin sha as equal
 *  when one is a prefix of the other. */
export function shaMatches(a: string, b: string): boolean {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x.startsWith(y) || y.startsWith(x)
}

/**
 * Decide PASS / STALE / AHEAD / UNKNOWN from the running sha, origin/main sha,
 * and their ancestry comparison. Pure — the caller supplies all three.
 */
export function decideVerdict(input: VerdictInput): Verdict {
  const { runningSha, originSha, comparison } = input
  if (!runningSha) {
    return {
      verdict: "UNKNOWN",
      message:
        "could not read a commit sha from x-maximal-version (release build, "
        + "or unexpected header format) — cannot verify build freshness",
    }
  }
  if (!originSha) {
    return {
      verdict: "UNKNOWN",
      message:
        `running build ${runningSha}, but origin/main is not resolvable — run `
        + "`git fetch origin main` and retry",
    }
  }
  if (shaMatches(runningSha, originSha)) {
    return {
      verdict: "PASS",
      message: `running build ${runningSha} == origin/main ${originSha}`,
    }
  }
  if (!comparison) {
    return {
      verdict: "UNKNOWN",
      message:
        `running build ${runningSha} differs from origin/main ${originSha}, `
        + "but the running commit is not in the local object DB — run "
        + "`git fetch origin main` and retry",
    }
  }
  if (comparison.isAncestor) {
    const n = comparison.behind
    return {
      verdict: "STALE",
      message:
        `STALE: running ${runningSha} is ${n} commit${n === 1 ? "" : "s"} `
        + `behind origin/main ${originSha}; rebuild needed (bun run app:dev)`,
    }
  }
  return {
    verdict: "AHEAD",
    message:
      `running ${runningSha} is not an ancestor of origin/main ${originSha} `
      + "(local commits ahead, or origin/main not fetched to HEAD) — "
      + "verify you intend to test uncommitted/unmerged work",
  }
}

export interface ConfigFlagStatus {
  /** Whether the config file was found + parsed. */
  readable: boolean
  /** Raw value of promptCacheRetention (undefined if unset). */
  promptCacheRetention: string | undefined
  /** True iff promptCacheRetention === "24h" (what a #252 E2E test needs). */
  retention24h: boolean
  /** Absolute config path we read (for the report). */
  path: string
}

/**
 * Given the parsed config object (or null when the file was absent /
 * unparseable), report whether `promptCacheRetention` is "24h". Pure — I/O is
 * the caller's job.
 */
export function assessConfigFlags(
  config: Record<string, unknown> | null,
  configPath: string,
): ConfigFlagStatus {
  if (config === null) {
    return {
      readable: false,
      promptCacheRetention: undefined,
      retention24h: false,
      path: configPath,
    }
  }
  const raw = config.promptCacheRetention
  const value = typeof raw === "string" ? raw : undefined
  return {
    readable: true,
    promptCacheRetention: value,
    retention24h: value === "24h",
    path: configPath,
  }
}

/**
 * Resolve the app-data config path exactly as the app does
 * (src/lib/paths.ts → resolveAppDir): `$COPILOT_API_HOME` overrides everywhere;
 * else `%APPDATA%\maximal` on win32; else `~/.local/share/maximal`. Kept in
 * sync with paths.ts by mirroring its precedence — pure so it's testable.
 */
export function resolveConfigPath(env: {
  platform: NodeJS.Platform
  homedir: string
  copilotApiHome?: string
  appData?: string
}): string {
  const override = env.copilotApiHome?.trim()
  const appDir =
    override ? override
    : env.platform === "win32" ?
      path.join(
        env.appData?.trim() || path.join(env.homedir, "AppData", "Roaming"),
        "maximal",
      )
    : path.join(env.homedir, ".local", "share", "maximal")
  return path.join(appDir, "config.json")
}

// ────────────────────────────────────────────────────────────────────
// Live I/O (thin; deps injected for testability)
// ────────────────────────────────────────────────────────────────────

export interface VerifyDeps {
  /** Fetch the x-maximal-version header for `baseUrl`; null if unreachable. */
  fetchVersionHeader: (baseUrl: string) => Promise<string | null>
  /** `git rev-parse --short origin/main`, or null if unresolvable. */
  gitOriginSha: () => string | null
  /** Compare `runningSha` to origin/main; null if the sha isn't in the DB. */
  gitCompare: (runningSha: string) => ShaComparison | null
  /** Read + parse the config file; null if absent/unparseable. */
  readConfig: (configPath: string) => Record<string, unknown> | null
}

async function defaultFetchVersionHeader(
  baseUrl: string,
): Promise<string | null> {
  try {
    // Cheapest identity probe; unauthenticated + loopback-friendly. We take
    // ONLY the version header — no load on the shared proxy.
    const res = await fetch(`${baseUrl}/status`, {
      signal: AbortSignal.timeout(3000),
    })
    return res.headers.get("x-maximal-version")
  } catch {
    return null
  }
}

function git(args: Array<string>): { status: number; stdout: string } {
  const r = spawnSync("git", args, { encoding: "utf8" })
  return { status: r.status ?? 1, stdout: (r.stdout ?? "").trim() }
}

function defaultGitOriginSha(): string | null {
  const r = git(["rev-parse", "--short", "origin/main"])
  return r.status === 0 && r.stdout.length > 0 ? r.stdout.toLowerCase() : null
}

function defaultGitCompare(runningSha: string): ShaComparison | null {
  // Bail if the running commit isn't in the local object DB — otherwise the
  // ancestry answer would be meaningless.
  if (git(["cat-file", "-e", `${runningSha}^{commit}`]).status !== 0) {
    return null
  }
  const isAncestor =
    git(["merge-base", "--is-ancestor", runningSha, "origin/main"]).status === 0
  const behindOut = git(["rev-list", "--count", `${runningSha}..origin/main`])
  const behind =
    behindOut.status === 0 ? Number.parseInt(behindOut.stdout, 10) || 0 : 0
  return { isAncestor, behind }
}

function defaultReadConfig(configPath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(configPath, "utf8")
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null ?
        (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const defaultDeps: VerifyDeps = {
  fetchVersionHeader: defaultFetchVersionHeader,
  gitOriginSha: defaultGitOriginSha,
  gitCompare: defaultGitCompare,
  readConfig: defaultReadConfig,
}

export interface VerifyReport {
  baseUrl: string
  proxyReachable: boolean
  runningVersion: string | null
  runningSha: string | null
  originSha: string | null
  verdict: Verdict
  config: ConfigFlagStatus
}

/**
 * Full readiness check. Fetches the version header, compares against
 * origin/main, and reads the config flag. Returns a structured report; the CLI
 * prints it and picks an exit code.
 */
export async function verifyBuild(
  baseUrl: string,
  configPath: string,
  deps: VerifyDeps = defaultDeps,
): Promise<VerifyReport> {
  const runningVersion = await deps.fetchVersionHeader(baseUrl)
  const runningSha = extractSha(runningVersion)
  const originSha = deps.gitOriginSha()
  const comparison =
    runningSha && originSha && !shaMatches(runningSha, originSha) ?
      deps.gitCompare(runningSha)
    : null
  const verdict = decideVerdict({ runningSha, originSha, comparison })
  const config = assessConfigFlags(deps.readConfig(configPath), configPath)
  return {
    baseUrl,
    proxyReachable: runningVersion !== null,
    runningVersion,
    runningSha,
    originSha,
    verdict,
    config,
  }
}

// ────────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────────

export function parseArgs(argv: Array<string>): { baseUrl: string } {
  const idx = argv.indexOf("--base-url")
  const flag = idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined
  const baseUrl =
    flag ?? process.env.MAXIMAL_BASE_URL ?? DEFAULT_BASE_URL
  return { baseUrl: baseUrl.replace(/\/$/, "") }
}

function printUnreachable(baseUrl: string): void {
  console.error("")
  console.error(`  No live proxy at ${baseUrl} — cannot verify the build.`)
  console.error("")
  console.error("  Start (or point at) a running proxy, then retry:")
  console.error("")
  console.error("    bun run app:dev            # rebuild + relaunch the sidecar")
  console.error("    bun run verify:build       # then re-run this check")
  console.error("")
  console.error(
    "  Or target another host/port with --base-url / MAXIMAL_BASE_URL.",
  )
  console.error("")
}

function printReport(report: VerifyReport): void {
  console.log("")
  console.log("  Build readiness")
  console.log("  " + "─".repeat(60))
  console.log(`  Proxy:   ${report.baseUrl}`)
  console.log(`  Running: ${report.runningVersion ?? "<unreachable>"}`)
  console.log(`  Verdict: ${report.verdict.verdict}`)
  console.log(`           ${report.verdict.message}`)
  console.log("")
  const cfg = report.config
  console.log("  Config flags (for live tests):")
  if (!cfg.readable) {
    console.log(`    config not readable at ${cfg.path}`)
    console.log(`    promptCacheRetention: <unknown>`)
  } else {
    console.log(`    config: ${cfg.path}`)
    console.log(
      `    promptCacheRetention: ${cfg.promptCacheRetention ?? "<unset>"}`
        + `  → #252 E2E ${cfg.retention24h ? "READY" : 'NOT READY (need "24h")'}`,
    )
  }
  console.log("  " + "─".repeat(60))
  console.log("")
}

async function main(): Promise<void> {
  const { baseUrl } = parseArgs(process.argv.slice(2))
  const configPath = resolveConfigPath({
    platform: process.platform,
    homedir: os.homedir(),
    copilotApiHome: process.env.COPILOT_API_HOME,
    appData: process.env.APPDATA,
  })
  const report = await verifyBuild(baseUrl, configPath)

  if (!report.proxyReachable) {
    printUnreachable(baseUrl)
    printReport(report)
    process.exitCode = 2
    return
  }

  printReport(report)
  // PASS → 0; STALE / UNKNOWN / AHEAD → 1 (the build isn't confirmed fresh).
  process.exitCode = report.verdict.verdict === "PASS" ? 0 : 1
}

if (import.meta.main) {
  await main()
}
