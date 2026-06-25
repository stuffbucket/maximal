/**
 * Update-available check — the notify-only half of self-update
 * (`docs/spec/phase-6-self-update.md`, Open Q#1). Resolves the latest published
 * release version from a JSON manifest the project site publishes at a
 * canonical URL (mxml.sh, fronting GitHub Pages) and compares it to the running
 * `BUILD_VERSION`. Config-gated (`config.checkUpdates`, default ON) and cached
 * so the Settings panel + the shell's periodic notification don't refetch
 * needlessly.
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

import { BUILD_CHANNEL, BUILD_VERSION } from "./build-info"
import { isUpdateCheckEnabled } from "./config"
import { GITHUB_API_TIMEOUT_MS } from "./http-timeouts"
import { createTeeLogger } from "./logger"

const log = createTeeLogger("update")

/** The update manifest — a small JSON document the project site publishes on
 *  every release. We fetch it straight from the GitHub Pages origin
 *  (Fastly-backed, GitHub's own CDN) rather than via the mxml.sh Caddy proxy:
 *  this is a machine-to-machine poll, so we want the fewest hops and the
 *  smallest trust surface — the proxy box can fail or be tampered with even
 *  when Pages is healthy. (The branded mxml.sh URL stays the *human*-facing
 *  download link — see `DOWNLOAD_URL`.) A static, CDN-cached object: NO auth
 *  and NO per-IP rate limit, so it scales to every client. (The REST API caps
 *  anonymous callers at 60/h/IP — a real failure mode behind a shared corporate
 *  NAT, where it silently returns "no update".) Channel-keyed, so opting a
 *  build into a future `beta` is a server-only + client-config change. */
const MANIFEST_URL =
  "https://stuffbucket.github.io/maximal/updates/manifest.json"

/** Which release channel this build follows — derived from the build's
 *  `BUILD_CHANNEL` (`stable` for source/stock builds; `beta` etc. when a
 *  channel binary injects `__MAXIMAL_CHANNEL__`). The manifest is
 *  channel-keyed, so a `beta` build polls the manifest's `beta` entry while
 *  `stable` keeps reading `stable`. */
const UPDATE_CHANNEL = BUILD_CHANNEL

/** Where to send the user to update — install-channel neutral. */
export const DOWNLOAD_URL = "https://mxml.sh/maximal/"

/** Cache the resolved status this long. Generous on purpose: a new release is
 *  rare, so there's no value re-fetching the CDN asset more often. The shell's
 *  periodic check and the occasional Settings open both read through this. */
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
  /** Whether update checking is enabled (`config.checkUpdates`). False means
   *  the mechanism is intentionally idle — not broken. */
  enabled: boolean
  /** ISO time of the last successful manifest fetch, or null if we've never
   *  reached it. Lets diagnostics show whether the check is actually running. */
  checked_at: string | null
  /** Short reason the most recent attempt didn't yield a usable version
   *  (network error, non-200, unparseable manifest), or null when the last
   *  attempt succeeded / checks are disabled. Diagnostic only — never thrown. */
  last_error: string | null
}

// Dependency-injection shim for tests, mirroring token.ts / auth-recovery.ts:
// a process-wide mock.module leaks across sibling test files, so the suite
// overrides fetch + the clock via __setUpdateCheckDepsForTests instead. The
// narrowed signature (vs `typeof fetch`) is what the real `fetch` and a plain
// stub are both assignable to — `typeof fetch` carries extras like `preconnect`.
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

let fetchImpl: FetchLike = fetch
let nowMs: () => number = Date.now
let versionImpl: string = BUILD_VERSION

export function __setUpdateCheckDepsForTests(o: {
  fetch?: FetchLike
  now?: () => number
  currentVersion?: string
}): void {
  if (o.fetch) fetchImpl = o.fetch
  if (o.now) nowMs = o.now
  if (o.currentVersion) versionImpl = o.currentVersion
}

export function __resetUpdateCheckDepsForTests(): void {
  fetchImpl = fetch
  nowMs = Date.now
  versionImpl = BUILD_VERSION
  cache = null
}

let cache: { atMs: number; status: UpdateStatus } | null = null

/**
 * Best-effort semver-precedence compare. Returns true if `a` is strictly newer
 * than `b`. Missing/garbage core segments read as 0.
 */
function parseSemver(v: unknown): [number, number, number, Array<string>] {
  const raw = typeof v === "string" ? v.replace(/^v/u, "") : ""
  const prereleaseAt = raw.indexOf("-")
  const core = prereleaseAt === -1 ? raw : raw.slice(0, prereleaseAt)
  const prerelease =
    prereleaseAt === -1 ? [] : raw.slice(prereleaseAt + 1).split(".")
  const parts = core.split(".").map((n) => Number.parseInt(n, 10) || 0)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, prerelease]
}

export function isNewerVersion(a: string, b: string): boolean {
  const [a0, a1, a2, aPre] = parseSemver(a)
  const [b0, b1, b2, bPre] = parseSemver(b)
  if (a0 !== b0) return a0 > b0
  if (a1 !== b1) return a1 > b1
  if (a2 !== b2) return a2 > b2
  if (aPre.length === 0 || bPre.length === 0) return bPre.length > 0
  for (let i = 0; i < Math.max(aPre.length, bPre.length); i++) {
    if (i >= aPre.length) return false
    if (i >= bPre.length) return true
    const aId = aPre[i]
    const bId = bPre[i]
    const aNum = /^\d+$/u.test(aId)
    const bNum = /^\d+$/u.test(bId)
    if (aNum && bNum) {
      const diff = Number.parseInt(aId, 10) - Number.parseInt(bId, 10)
      if (diff !== 0) return diff > 0
    } else if (aNum !== bNum) {
      return !aNum
    } else if (aId !== bId) {
      return aId > bId
    }
  }
  return false
}

/**
 * Strip a local-build suffix (`-dev+<sha>`) so a dev binary compares on its
 * core version. build-sidecar.ts stamps non-release binaries as
 * `<pkg.version>-dev+<sha>`; without this, a dev build of the current release
 * (e.g. `0.4.35-dev+abc`) reads as *older* than the published `0.4.35` — since
 * semver ranks a prerelease below its release — and perpetually self-reports
 * "update available" for the version it's already running. A real prerelease
 * channel (`-beta.N`, `-rc.N`) is left intact: those genuinely precede the
 * release and should still see it as an upgrade.
 */
function normalizeCurrent(version: string): string {
  const devAt = version.indexOf("-dev+")
  return devAt === -1 ? version : version.slice(0, devAt)
}

interface UpdateManifest {
  channels?: Record<string, { version?: unknown } | undefined>
}

/**
 * Pull a channel's version string out of the manifest JSON. Strict and
 * best-effort: returns null for any shape we don't recognize (bad JSON, missing
 * channel, non-version string), so a malformed — or tampered — manifest
 * degrades to "unknown" rather than reporting a bogus release. The download
 * destination is never read from the manifest; see `DOWNLOAD_URL`.
 */
export function parseManifestVersion(
  body: string,
  channel: string = UPDATE_CHANNEL,
): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  const entry = (parsed as UpdateManifest | null)?.channels?.[channel]
  const version = entry?.version
  if (typeof version !== "string") return null
  const match = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/u.exec(version.trim())
  return match ? match[1] : null
}

/**
 * Resolve whether a newer release is available. NEVER throws: any failure
 * (disabled, offline, non-200, timeout, malformed manifest) returns a coherent
 * status carrying diagnostic fields — `enabled`, `checked_at`, `last_error` —
 * and the last known `latest` if we have one, so a transient blip doesn't erase
 * a real result. `force` bypasses the cache.
 */
export async function getUpdateStatus(force = false): Promise<UpdateStatus> {
  const current = versionImpl
  const enabled = isUpdateCheckEnabled()
  const checkedAt = cache ? new Date(cache.atMs).toISOString() : null

  // Disabled is an intentional idle state, not a failure: report it cleanly,
  // with no stale result and no error.
  if (!enabled) {
    return {
      current,
      latest: null,
      update_available: false,
      url: DOWNLOAD_URL,
      enabled: false,
      checked_at: checkedAt,
      last_error: null,
    }
  }

  if (!force && cache && nowMs() - cache.atMs < CACHE_TTL_MS) {
    return cache.status
  }

  // A failed attempt keeps the last known result (if any) and surfaces why.
  const fallback = (error: string): UpdateStatus => ({
    current,
    latest: cache?.status.latest ?? null,
    update_available: cache?.status.update_available ?? false,
    url: DOWNLOAD_URL,
    enabled: true,
    checked_at: checkedAt,
    last_error: error,
  })

  try {
    const res = await fetchImpl(MANIFEST_URL, {
      headers: { "user-agent": "maximal" },
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    })
    if (!res.ok) {
      // Transient CDN/network blip, or a manifest not yet deployed.
      const error = `manifest fetch returned HTTP ${res.status}`
      log.warn(`Update check: ${error}; skipping.`)
      return fallback(error)
    }
    const latest = parseManifestVersion(await res.text())
    const error =
      latest === null ? "manifest had no usable version for this channel" : null
    const atMs = nowMs()
    const status: UpdateStatus = {
      current,
      latest,
      update_available:
        latest !== null && isNewerVersion(latest, normalizeCurrent(current)),
      url: DOWNLOAD_URL,
      enabled: true,
      checked_at: new Date(atMs).toISOString(),
      last_error: error,
    }
    // Single-threaded module: a concurrent check would re-fetch and overwrite
    // with identical data, so the "race" the rule warns about is harmless here.
    // eslint-disable-next-line require-atomic-updates
    cache = { atMs, status }
    return status
  } catch (err) {
    const error =
      err instanceof Error ?
        `network error: ${err.message}`
      : "update check failed"
    log.warn("Update check failed (continuing):", err)
    return fallback(error)
  }
}
