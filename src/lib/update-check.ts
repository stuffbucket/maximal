/**
 * Update-available check — the notify-only half of self-update
 * (`docs/spec/phase-6-self-update.md`, Open Q#1). Resolves the latest published
 * release tag from the GitHub API and compares it to the running
 * `BUILD_VERSION`. Config-gated (`config.checkUpdates`, default ON) and cached
 * so the Settings panel + the shell's once-per-day notification don't hammer
 * the anonymous API.
 *
 * Install-channel neutral: we point users at `https://mxml.sh` (the download
 * page that routes to the right artifact / package manager) rather than a raw
 * release asset, because the running build could be a brew/npm/MSI install that
 * shouldn't be clobbered by a bare binary swap.
 *
 * Best-effort throughout: any failure (offline, rate-limited, malformed body)
 * reports `update_available: false` instead of throwing — a missing update
 * ping must never degrade the proxy.
 */

import { BUILD_VERSION } from "./build-info"
import { isUpdateCheckEnabled } from "./config"
import { GITHUB_API_TIMEOUT_MS } from "./http-timeouts"
import { createTeeLogger } from "./logger"

const log = createTeeLogger("update")

const RELEASES_LATEST_URL =
  "https://api.github.com/repos/stuffbucket/maximal/releases/latest"

/** Where to send the user to update — install-channel neutral. */
export const DOWNLOAD_URL = "https://mxml.sh/maximal/"

/** Cache the resolved status this long. Generous on purpose: a new release is
 *  rare and the anon GitHub API is rate-limited (60/h/IP). The shell's daily
 *  notification and the occasional Settings open both read through this. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

export interface UpdateStatus {
  /** The running build's version. */
  current: string
  /** Latest published release version (no leading "v"), or null if unknown. */
  latest: string | null
  /** True only when `latest` is strictly newer than `current`. */
  update_available: boolean
  /** Where to get it. */
  url: string
}

// Dependency-injection shim for tests, mirroring token.ts / auth-recovery.ts:
// a process-wide mock.module leaks across sibling test files, so the suite
// overrides fetch + the clock via __setUpdateCheckDepsForTests instead. The
// narrowed signature (vs `typeof fetch`) is what the real `fetch` and a plain
// stub are both assignable to — `typeof fetch` carries extras like `preconnect`.
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

let fetchImpl: FetchLike = fetch
let nowMs: () => number = Date.now

export function __setUpdateCheckDepsForTests(o: {
  fetch?: FetchLike
  now?: () => number
}): void {
  if (o.fetch) fetchImpl = o.fetch
  if (o.now) nowMs = o.now
}

export function __resetUpdateCheckDepsForTests(): void {
  fetchImpl = fetch
  nowMs = Date.now
  cache = null
}

let cache: { atMs: number; status: UpdateStatus } | null = null

/**
 * Numeric compare of two `x.y.z` versions. A leading `v` and any `-prerelease`
 * suffix are stripped (the releases/latest endpoint returns the latest STABLE
 * by default, so we never compare against a prerelease). Returns true if `a` is
 * strictly newer than `b`. Missing/garbage segments read as 0.
 */
function parseSemver(v: string): [number, number, number] {
  const core = v.replace(/^v/u, "").split("-")[0]
  const parts = core.split(".").map((n) => Number.parseInt(n, 10) || 0)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

export function isNewerVersion(a: string, b: string): boolean {
  const [a0, a1, a2] = parseSemver(a)
  const [b0, b1, b2] = parseSemver(b)
  if (a0 !== b0) return a0 > b0
  if (a1 !== b1) return a1 > b1
  return a2 > b2
}

/**
 * Resolve whether a newer release is available. Returns a coherent
 * `update_available: false` status (with `latest: null`) whenever the check is
 * disabled or anything goes wrong. `force` bypasses the cache.
 */
export async function getUpdateStatus(force = false): Promise<UpdateStatus> {
  const current = BUILD_VERSION
  const unknown: UpdateStatus = {
    current,
    latest: null,
    update_available: false,
    url: DOWNLOAD_URL,
  }

  if (!isUpdateCheckEnabled()) return unknown
  if (!force && cache && nowMs() - cache.atMs < CACHE_TTL_MS) {
    return cache.status
  }

  try {
    const res = await fetchImpl(RELEASES_LATEST_URL, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "maximal",
      },
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    })
    if (!res.ok) {
      log.warn(`Update check: GitHub returned ${res.status}; skipping.`)
      return unknown
    }
    const body = (await res.json()) as { tag_name?: string }
    const latest = body.tag_name ? body.tag_name.replace(/^v/u, "") : null
    const status: UpdateStatus = {
      current,
      latest,
      update_available: latest !== null && isNewerVersion(latest, current),
      url: DOWNLOAD_URL,
    }
    // Single-threaded module: a concurrent check would re-fetch and overwrite
    // with identical data, so the "race" the rule warns about is harmless here.
    // eslint-disable-next-line require-atomic-updates
    cache = { atMs: nowMs(), status }
    return status
  } catch (err) {
    log.warn("Update check failed (continuing):", err)
    return unknown
  }
}
