# Network-blocked auth — diagnosis & follow-ups

## Context

When maximal's Copilot token mint/refresh can't reach GitHub's
authentication endpoint, it fails at the **transport layer** — no HTTP
status, just a socket error. On Bun this surfaces as `{ code:
"ConnectionRefused" | "FailedToOpenSocket", path: "<url>", errno: 0 }`; on
node/undici as `TypeError: fetch failed` with a nested `.cause`.

Note the failure can be **specific to authentication** — general internet and
even `github.com` may be reachable while only the auth/token endpoint drops.
So we report the observable fact ("can't reach the authentication provider")
and do **not** assert a root cause (ZTNA, device-compliance, VPN, outage)
unless an upstream response actually says so — a bare transport `code` can't
distinguish them.

Historically this was invisible:

- The refresh loop treated it as a generic retryable error and looped every
  ~15s forever (hundreds of identical log lines).
- The fail-closed log redactor masked `code` and `path` to `[redacted N
  chars]`, so the logs couldn't even tell you *which* transport error it was.
- The completion-path 401 that eventually flipped the account to
  `needsReauth` (`forwardError` → `markAuthDegraded`) left **no** line in the
  dated `auth-*.log`.

## What now exists

- `src/lib/net/network-diagnostics.ts` — detects transport errors, probes what
  actually works (raw IP egress to Cloudflare 1.1.1.1 / 1.0.0.1 + IPv6, DNS
  resolution, active interface count) and classifies into a **typed** verdict:
  `kind` (`offline` / `dns-failure` / `scope-unreachable` / `unknown`) plus a
  typed, extensible `scope` (today only `github-copilot-auth`). It carries **no
  user-facing prose** — the message is the UI's job (i18n, keyed on
  `(kind, scope)`), built close to where it's rendered. Cached ~60s.
  - **Target-agnostic:** no provider host/URL is baked in. The caller passes a
    `NetworkTarget` (`{ scope, url }`) describing what it was trying to reach;
    the DNS probe resolves that URL's host (`hostFromUrl`). Only the Cloudflare
    egress anchors are hard-coded, purely as a generic "is egress working"
    litmus. Diagnosing a new service = add a `NETWORK_SCOPE` entry + pass its
    URL; no library change.
  - Callers interpret the verdict via the exported `NETWORK_DIAGNOSIS_KIND`
    constants or the `isOffline` / `isDnsFailure` / `isScopeUnreachable`
    predicates — never a raw `kind === "offline"` string compare (rots on
    rename). All magic values (IPs, port, families, scope) are named constants.
- `token.ts` refresh loop + first-mint path log the typed classification via
  `formatDiagnosisForLog` (a dev-log string — no i18n; survives the file sink's
  secret-scrubber so the safe transport fields stay visible). It passes the
  target `{ scope: NETWORK_SCOPE.githubCopilotAuth, url: getCopilotTokenUrl() }`
  (the shared endpoint constant in `api-config.ts`).
- `log-redact.ts` allowlists the unambiguous socket/DNS error keys (`syscall`,
  `hostname`, `address`). `code` / `path` stay redacted (they collide with
  content keys); transport errors are logged as safe strings instead.
- `auth-controller.ts` `runDegrade` now tees a line to `auth-*.log` when an
  account is flagged `needsReauth`.
- The latest typed verdict is exposed via `getLastNetworkDiagnosis()` for a
  future UI banner to read (and translate) without re-probing.

## Testing

- `tests/network-diagnostics.test.ts` is deterministic and offline (the project
  convention): every scenario injects behavior through the probe DI seam.
- `tests/helpers/rfc-network-fixtures.ts` supplies **IETF-reserved** values so
  each case maps to a standard-guaranteed outcome instead of a drift-prone real
  host: RFC 5737 / RFC 3849 documentation IPs (guaranteed unreachable), RFC 6761
  `.invalid` (guaranteed NXDOMAIN — models a *bad/blocked name*, distinct from a
  dead resolver), and RFC 2606 `example.com` (reserved but resolvable — the "is
  the resolver alive?" anchor, and the stand-in for *any* reachable host). Tests
  assert these **invariants** only — never a live host like `api.github.com`
  whose reachability flips the moment the incident clears.
- An **opt-in** real-network suite (`describe.skipIf(!process.env.MAXIMAL_NETWORK_TESTS)`)
  dials the real `defaultDnsLookup` / `defaultTcpConnect` / `probeNetwork` against
  those same fixtures to confirm the live probes observe the RFC-guaranteed
  behavior the deterministic suite assumes. Skipped by default; run with
  `MAXIMAL_NETWORK_TESTS=1 bun test tests/network-diagnostics.test.ts`.

## Follow-ups (intentionally not done yet)

1. **Surface a distinct "scope-unreachable" state in the UI.** Right now the
   typed diagnosis only reaches the log + `getLastNetworkDiagnosis()`. A
   dedicated auth-state / Settings banner — with the user-facing copy produced
   by the i18n framework, keyed on `(kind, scope)` — distinct from "your token
   is invalid → re-auth" would stop users from pointlessly re-signing-in. Needs
   SSE event + i18n strings (`shell/src/i18n/*`). New scopes (other providers)
   extend the `NetworkScope` union.

2. **Interface rebinding / discovery.** When `activeInterfaces.length > 1`, a
   working network may have come up *after* maximal started and our socket is
   bound to a dead interface. The typed verdict exposes `probe.activeInterfaces`
   for a caller to act on; today nothing does. A real fix would watch for
   interface changes (`os` / a native watcher) and force a fresh connection
   (Bun/undici don't expose easy per-request source
   binding — investigate a custom dispatcher or a full client re-init).

3. **Pin down *why* the auth endpoint is unreachable.** We deliberately do NOT
   assert a cause — the same transport error covers a network/VPN/proxy policy,
   an auth-provider outage, and a TLS-interception drop. If we want to say more,
   we'd need corroborating signals: reachability of `github.com` vs
   `api.github.com` vs the token endpoint specifically, presence of a
   `utun*`/`ppp*` (VPN) interface, whether an upstream response carries a
   policy/notification body, etc. Until then, "can't reach the authentication
   provider" is the honest ceiling.

4. **Captive-portal detection nuance.** `dns-failure` covers the common case,
   but some portals *poison* DNS (return a portal IP) rather than fail it.
   Detecting that (probe a known-content URL and check for a redirect) is a
   possible enhancement.

5. **Probe cost.** Each diagnosis does a handful of TCP connects + DNS lookups
   (bounded, cached ~60s). Fine at the current 15s retry cadence; revisit if
   the retry cadence tightens.
