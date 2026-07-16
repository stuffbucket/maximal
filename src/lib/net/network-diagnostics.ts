/**
 * Network failure diagnosis for outbound provider requests.
 *
 * When a request fails at the *transport* layer (no HTTP status — the socket
 * never completed), the raw error is an opaque `{ code, path, errno }` shape
 * (Bun's fetch) or a `TypeError: fetch failed` (node/undici). Logged as-is it
 * tells nobody anything, and the fail-closed log redactor masks `code`/`path`
 * entirely (see `log-redact.ts`). Worse, a retry loop treats it as a generic
 * retryable error and loops silently forever — there is no signal
 * distinguishing "your credential is invalid" (re-auth fixes it) from "we
 * can't reach the service" (re-auth won't).
 *
 * This module turns a transport error into a *typed*, safe-to-log diagnosis by
 * probing what actually works:
 *
 *   1. Raw IP egress — TCP-connect to Cloudflare's anycast resolvers
 *      (1.1.1.1 / 1.0.0.1 and their IPv6 equivalents) on 443. This is a pure
 *      "can any packet leave the box" litmus, independent of DNS or any host.
 *   2. DNS — resolve the *caller-supplied* target host. IPs-reachable-but-DNS-
 *      broken is the classic captive/hotel-network signature.
 *   3. If both work but the request to its `scope` (an extensible typed service
 *      identifier — e.g. GitHub Copilot's auth endpoint) didn't complete, we
 *      report only the observable fact — that scope is unreachable — WITHOUT
 *      asserting a cause. General internet (even github.com) may be fine; a
 *      transport `code` alone can't tell a network/VPN/proxy policy apart from
 *      an upstream outage or a TLS drop, so we don't guess.
 *
 * The library is deliberately *target-agnostic*: it bakes in no provider host
 * or URL. The caller passes a `NetworkTarget` ({ scope, url }) describing what
 * it was trying to reach; the DNS probe resolves that URL's host. Only the
 * Cloudflare egress anchors are hard-coded, and purely as a generic
 * "is any egress working" litmus — not as a target.
 *
 * The verdict is intentionally i18n-free and prose-free: it's a typed
 * `(kind, scope)` value. The user-facing message is the UI's responsibility,
 * built via the internationalization framework close to where it's rendered.
 * Logging may render the typed fields into a plain string (`formatDiagnosisForLog`).
 *
 * Deliberately shallow: interface *rebinding* and pinning down *why* a scope is
 * unreachable (policy vs outage vs VPN) are noted as follow-ups in
 * `docs/dev/network-blocked-auth.md`.
 */

import dnsPromises from "node:dns/promises"
import net from "node:net"
import os from "node:os"

/** IP protocol families, named so probe code reads without bare 4/6 literals.
 *  Exported so tests can pair a reserved address with its family. */
export const IP_FAMILY = { v4: 4, v6: 6 } as const
export type IpFamily = (typeof IP_FAMILY)[keyof typeof IP_FAMILY]

/**
 * Cloudflare's public anycast DNS resolver IPs. Globally-routed and stable,
 * they're used purely as a raw-egress litmus (TCP connect) — independent of
 * DNS or any GitHub host. See
 * https://developers.cloudflare.com/1.1.1.1/ip-addresses/
 */
const CLOUDFLARE_DNS_IPV4_PRIMARY = "1.1.1.1"
const CLOUDFLARE_DNS_IPV4_SECONDARY = "1.0.0.1"
const CLOUDFLARE_DNS_IPV6_PRIMARY = "2606:4700:4700::1111"
const CLOUDFLARE_DNS_IPV6_SECONDARY = "2606:4700:4700::1001"

/** TCP port dialed for the reachability litmus (HTTPS). Exported so tests dial
 *  reserved endpoints on the same port the probe uses. */
export const HTTPS_PORT = 443

/** Per-probe (TCP connect / DNS lookup) timeout. */
const PROBE_TIMEOUT_MS = 2_500

/** IP reachability targets: (IP, family) pairs the egress litmus dials. These
 *  are generic egress anchors (Cloudflare), NOT a diagnosis target. */
const REACHABILITY_TARGETS: ReadonlyArray<{ host: string; family: IpFamily }> =
  [
    { host: CLOUDFLARE_DNS_IPV4_PRIMARY, family: IP_FAMILY.v4 },
    { host: CLOUDFLARE_DNS_IPV4_SECONDARY, family: IP_FAMILY.v4 },
    { host: CLOUDFLARE_DNS_IPV6_PRIMARY, family: IP_FAMILY.v6 },
    { host: CLOUDFLARE_DNS_IPV6_SECONDARY, family: IP_FAMILY.v6 },
  ]

/**
 * Error `code` values that mean "the transport failed" rather than "the server
 * answered". Covers Bun's fetch names and node/undici/libuv codes. Matched
 * case-sensitively against `err.code` (and `err.cause.code`).
 */
const TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  // Bun fetch
  "ConnectionRefused",
  "ConnectionClosed",
  "ConnectionResetByPeer",
  "ConnectionTimeout",
  "FailedToOpenSocket",
  "WouldBlock",
  // node / undici / libuv
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPROTO",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
])

export interface TransportErrorSummary {
  /** Error code, e.g. `ConnectionRefused` / `ETIMEDOUT`. */
  code: string | null
  errno: number | null
  syscall: string | null
  /** Request URL (Bun puts it on `path`) — a fixed first-party API endpoint,
   *  never user content, so safe to surface. */
  url: string | null
  name: string | null
  message: string | null
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ?
    (value as Record<string, unknown>)
  : null

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null

const num = (v: unknown): number | null => (typeof v === "number" ? v : null)

/**
 * True iff `err` is a transport-layer failure (no HTTP status) rather than an
 * application error. Recognises the Bun `{ code, path, errno }` shape, node
 * error codes, `TimeoutError` (AbortSignal.timeout), and `TypeError: fetch
 * failed` (unwrapping `.cause`). A deliberate `AbortError` is NOT a transport
 * failure — it's our own teardown — so it returns false.
 */
export function isTransportError(err: unknown): boolean {
  const rec = asRecord(err)
  if (!rec) return false

  const name = str(rec.name)
  if (name === "AbortError") return false
  // AbortSignal.timeout rejects with a DOMException named TimeoutError.
  if (name === "TimeoutError") return true

  const code = str(rec.code)
  if (code && TRANSPORT_ERROR_CODES.has(code)) return true

  // node/undici surface `TypeError: fetch failed` with the real cause nested.
  const causeCode = str(asRecord(rec.cause)?.code)
  if (causeCode && TRANSPORT_ERROR_CODES.has(causeCode)) return true
  if (name === "TypeError" && str(rec.message) === "fetch failed") return true

  // Bun's fetch error is a plain `Error` carrying `code` + `path` + `errno`.
  if ("path" in rec && "errno" in rec && code !== null) return true

  return false
}

/** Extract the safe, human-meaningful fields from a transport error. Unwraps a
 *  nested `.cause` (node/undici) so the underlying code/syscall surface. */
export function summarizeTransportError(err: unknown): TransportErrorSummary {
  const rec = asRecord(err) ?? {}
  const cause = asRecord(rec.cause) ?? {}
  return {
    code: str(rec.code) ?? str(cause.code),
    errno: num(rec.errno) ?? num(cause.errno),
    syscall: str(rec.syscall) ?? str(cause.syscall),
    // Bun stores the request URL on `path`; node stores it nowhere useful.
    url: str(rec.path) ?? str(cause.path),
    name: str(rec.name),
    message: str(rec.message),
  }
}

/** Compact single-line rendering of a transport summary, safe for the file
 *  sink (only fixed structural values, no content). */
export function formatTransportError(summary: TransportErrorSummary): string {
  const parts: Array<string> = []
  if (summary.code) parts.push(`code=${summary.code}`)
  if (summary.syscall) parts.push(`syscall=${summary.syscall}`)
  if (summary.errno !== null) parts.push(`errno=${summary.errno}`)
  if (summary.url) parts.push(`url=${summary.url}`)
  if (parts.length === 0 && summary.message) parts.push(summary.message)
  return parts.join(" ")
}

export interface NetworkProbe {
  /** Any reachability target connected (v4 or v6). */
  ipReachable: boolean
  ipv4Reachable: boolean
  ipv6Reachable: boolean
  /** At least one DNS probe host resolved. */
  dnsResolves: boolean
  /** Names of non-internal interfaces that currently have an address. More
   *  than one hints a switch/rebind might restore service (see follow-up doc). */
  activeInterfaces: Array<string>
}

/** Injectable seam so tests can drive the classifier without real sockets. */
export interface ProbeDeps {
  tcpConnect?: (
    host: string,
    port: number,
    family: IpFamily,
  ) => Promise<boolean>
  dnsLookup?: (host: string) => Promise<boolean>
  interfaces?: () => Array<string>
}

/** The real TCP-reachability probe (a bare connect on `port`). Exported so the
 *  opt-in real-network test suite can drive it against RFC-reserved endpoints;
 *  production code reaches it through `probeNetwork`'s default. */
export const defaultTcpConnect = (
  host: string,
  port: number,
  family: IpFamily,
): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false
    const socket = net.connect({ host, port, family })
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS)
    socket.once("connect", () => done(true))
    socket.once("timeout", () => done(false))
    socket.once("error", () => done(false))
  })

/** The real DNS-liveness probe (a `getaddrinfo` with a timeout). Exported so
 *  the opt-in real-network test suite can verify it against RFC-reserved names;
 *  production code reaches it through `probeNetwork`'s default. */
export const defaultDnsLookup = async (host: string): Promise<boolean> => {
  try {
    // getaddrinfo (matches what fetch does) with a hard timeout so a hung
    // resolver can't stall the whole diagnosis.
    const result = await Promise.race([
      dnsPromises.lookup(host),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("dns-timeout")), PROBE_TIMEOUT_MS),
      ),
    ])
    return Boolean(result)
  } catch {
    return false
  }
}

const defaultInterfaces = (): Array<string> => {
  const out: Array<string> = []
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (addrs?.some((a) => !a.internal)) out.push(name)
  }
  return out
}

/** Extract the host from a URL for the DNS probe. Returns null for a
 *  non-absolute / unparseable URL so a bad target can't crash diagnosis. */
export function hostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

/** Probe raw IP egress, DNS, and interface count. Never throws. `dnsHosts` are
 *  the caller's target host(s) to resolve; when empty, DNS is treated as
 *  working (we can't disprove what we didn't probe). */
export async function probeNetwork(
  deps: ProbeDeps = {},
  dnsHosts: ReadonlyArray<string> = [],
): Promise<NetworkProbe> {
  const tcpConnect = deps.tcpConnect ?? defaultTcpConnect
  const dnsLookup = deps.dnsLookup ?? defaultDnsLookup
  const interfaces = deps.interfaces ?? defaultInterfaces

  const results = await Promise.all(
    REACHABILITY_TARGETS.map((t) =>
      tcpConnect(t.host, HTTPS_PORT, t.family).then((ok) => ({
        family: t.family,
        ok,
      })),
    ),
  )
  const ipv4Reachable = results.some((r) => r.family === IP_FAMILY.v4 && r.ok)
  const ipv6Reachable = results.some((r) => r.family === IP_FAMILY.v6 && r.ok)

  const dnsResults = await Promise.all(dnsHosts.map((h) => dnsLookup(h)))

  return {
    ipReachable: ipv4Reachable || ipv6Reachable,
    ipv4Reachable,
    ipv6Reachable,
    dnsResolves: dnsHosts.length === 0 || dnsResults.some(Boolean),
    activeInterfaces: interfaces(),
  }
}

export const NETWORK_SCOPE = {
  githubCopilotAuth: "github-copilot-auth",
} as const

/**
 * A named upstream scope a diagnosis can implicate. The failing request always
 * targets *some* service; this identifies which, so a caller (and ultimately
 * the UI) can react per-scope. Extensible union — today only GitHub Copilot's
 * token/authentication endpoint, but other providers/endpoints will be added
 * as the proxy grows. Keep values stable: they may key i18n strings and
 * telemetry. Reference `NETWORK_SCOPE.*`, never the raw literal.
 */
export type NetworkScope = (typeof NETWORK_SCOPE)[keyof typeof NETWORK_SCOPE]

/**
 * What a caller was trying to reach when the transport failed. Supplying this
 * keeps the library target-agnostic: `scope` is the typed identifier echoed
 * into the verdict (and keys the UI's i18n/telemetry), while `url` is the
 * concrete endpoint whose host the DNS probe resolves. No provider host or URL
 * is baked into this module — add a new `NETWORK_SCOPE` entry and pass its URL
 * to diagnose a different service.
 */
export interface NetworkTarget {
  scope: NetworkScope
  url: string
}

export const NETWORK_DIAGNOSIS_KIND = {
  /** No raw IP egress at all — the host can't reach the public internet. */
  offline: "offline",
  /** IP egress works but name resolution fails (captive portal / broken VPN DNS). */
  dnsFailure: "dns-failure",
  /** IP + DNS both work, yet the request to its `scope` didn't complete. */
  scopeUnreachable: "scope-unreachable",
  /** Transport failed but the probe couldn't place it in a bucket. */
  unknown: "unknown",
} as const

/**
 * The verdict discriminant. Callers must interpret it through the exported
 * `NETWORK_DIAGNOSIS_KIND` constants or the `is*` predicate helpers below —
 * never by comparing against a raw string literal, which rots on rename.
 */
export type NetworkDiagnosisKind =
  (typeof NETWORK_DIAGNOSIS_KIND)[keyof typeof NETWORK_DIAGNOSIS_KIND]

/**
 * A *typed*, i18n-free verdict. Deliberately carries NO user-facing prose: the
 * message shown to a user must be produced by the UI's internationalization
 * framework, keyed on `(kind, scope)`, close to where it's rendered — not baked
 * in here. Logging may render these fields into a plain string directly (a dev
 * log line needs no translation).
 */
export interface NetworkDiagnosis {
  kind: NetworkDiagnosisKind
  /** The upstream scope the failed request targeted. For `scope-unreachable`
   *  this is the thing we couldn't reach; on the scope-independent buckets
   *  (`offline`/`dns-failure`) it's echoed back for context. `null` when the
   *  caller didn't supply one. */
  scope: NetworkScope | null
  summary: TransportErrorSummary
  probe: NetworkProbe
}

/**
 * Bucket a transport error + probe result into a typed verdict. No user-facing
 * text — see `NetworkDiagnosis`. `scope` identifies what the failing request
 * targeted and is echoed into the result.
 */
export function classifyNetworkFailure(
  summary: TransportErrorSummary,
  probe: NetworkProbe,
  scope: NetworkScope | null = null,
): NetworkDiagnosis {
  if (!probe.ipReachable) {
    return { kind: NETWORK_DIAGNOSIS_KIND.offline, scope, summary, probe }
  }
  if (!probe.dnsResolves) {
    return { kind: NETWORK_DIAGNOSIS_KIND.dnsFailure, scope, summary, probe }
  }
  // IP + DNS both work (general internet, incl. github.com, may be fine), yet
  // the request to `scope` didn't complete. We report only the observable fact
  // — that scope is unreachable — NOT a cause: a bare transport `code` can't
  // tell a network/VPN/proxy policy apart from an upstream outage or a TLS
  // drop. Any causal wording is the UI's call, and only if corroborated.
  return {
    kind: NETWORK_DIAGNOSIS_KIND.scopeUnreachable,
    scope,
    summary,
    probe,
  }
}

/**
 * Typed predicates so callers interpret a verdict without hard-coding a string
 * comparison (`diag.kind === "offline"`), which rots on rename. Prefer these,
 * or an exhaustive `switch` over `NETWORK_DIAGNOSIS_KIND`, at every call site.
 */
export const isOffline = (d: NetworkDiagnosis): boolean =>
  d.kind === NETWORK_DIAGNOSIS_KIND.offline
export const isDnsFailure = (d: NetworkDiagnosis): boolean =>
  d.kind === NETWORK_DIAGNOSIS_KIND.dnsFailure
export const isScopeUnreachable = (d: NetworkDiagnosis): boolean =>
  d.kind === NETWORK_DIAGNOSIS_KIND.scopeUnreachable

/**
 * Render a diagnosis as a single developer-log line. This is dev-facing log
 * content (no translation), so inlining English here is fine — distinct from
 * the user-facing message, which the UI must build via i18n.
 */
export function formatDiagnosisForLog(diagnosis: NetworkDiagnosis): string {
  const { kind, scope, probe, summary } = diagnosis
  const parts: Array<string> = [kind]
  if (scope) parts.push(`scope=${scope}`)
  parts.push(
    `ip=${probe.ipReachable ? "ok" : "down"}`,
    `dns=${probe.dnsResolves ? "ok" : "down"}`,
    `ifaces=${probe.activeInterfaces.length}`,
  )
  const transport = formatTransportError(summary)
  if (transport) parts.push(transport)
  return parts.join(" ")
}

interface CachedDiagnosis {
  at: number
  value: NetworkDiagnosis
}
let lastDiagnosis: CachedDiagnosis | null = null
/** Don't re-probe more than once per window: the refresh loop retries every
 *  ~15s and the verdict rarely flips between attempts. */
const DIAGNOSIS_CACHE_MS = 60_000

// Sync setter so the last-write-wins cache update doesn't sit lexically after
// an `await` (which trips require-atomic-updates). Concurrent diagnoses simply
// overwrite — acceptable for a best-effort telemetry cache.
const setLastDiagnosis = (value: NetworkDiagnosis, at: number): void => {
  lastDiagnosis = { at, value }
}

/** The most recent diagnosis, if any — for a future UI banner to read without
 *  re-probing (see follow-up doc). */
export function getLastNetworkDiagnosis(): NetworkDiagnosis | null {
  return lastDiagnosis?.value ?? null
}

/** Reset cached state. Test-only. */
export function __resetNetworkDiagnosisCacheForTests(): void {
  lastDiagnosis = null
}

/**
 * High-level entry point: summarise the error, probe the network (cached), and
 * classify into a typed verdict. `target` names what the failing request was
 * trying to reach — its `scope` is echoed into the result and its `url`'s host
 * is DNS-probed. Falls back to the URL embedded in the transport error (Bun
 * puts it on `path`) when no target is supplied. Never throws — diagnosis is
 * best-effort telemetry.
 */
export async function diagnoseNetworkError(
  err: unknown,
  deps: ProbeDeps & { target?: NetworkTarget; now?: () => number } = {},
): Promise<NetworkDiagnosis> {
  const summary = summarizeTransportError(err)
  const scope = deps.target?.scope ?? null
  const now = deps.now ?? Date.now
  const cached = lastDiagnosis
  if (cached && now() - cached.at < DIAGNOSIS_CACHE_MS) {
    // Reuse the cached probe verdict, but refresh the per-call fields (this
    // error's summary + the caller's scope).
    return { ...cached.value, scope, summary }
  }
  const targetHost = hostFromUrl(deps.target?.url ?? summary.url)
  const probe = await probeNetwork(deps, targetHost ? [targetHost] : [])
  const value = classifyNetworkFailure(summary, probe, scope)
  setLastDiagnosis(value, now())
  return value
}
