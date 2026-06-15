---
id: ADR-0015
title: Claude Code routing — ungraceful-exit lifecycle gap
status: accepted
date: 2026-06-15
authors:
  - stuffbucket
supersedes: []
related_adrs:
  - docs/decisions/0009-app-integration-interface.md
links:
  reconciler: src/lib/claude-code-reconcile.ts
  writer: src/lib/claude-code-settings.ts
  shutdown: src/lib/start/shutdown.ts
  sentinel: src/lib/start/session-sentinel.ts
  v0_4_13_pivot_commit: cf0f578
---

# Claude Code routing — ungraceful-exit lifecycle gap

## Context

Since v0.4.13 (commit cf0f578) maximal routes Claude Code through
the proxy by writing `env.ANTHROPIC_BASE_URL` into
`~/.claude/settings.json`. The decision was correct: writing
settings.json sidesteps every shim failure mode (version pinning,
PATH ordering, process-name identity guards) that the prior PATH-
shim approach had.

But it introduced a new failure mode the PATH-shim would have
caught: **settings.json is static; it doesn't know whether the
proxy is currently alive**. When the proxy isn't running, `claude`
reads `ANTHROPIC_BASE_URL=http://localhost:4141`, attempts the
request, and produces "connection refused" or similarly opaque
errors.

The intent was for `reconcileClaudeCodeOnShutdown` to revert the
URL on shutdown so this never happens. That works in the *graceful*
exit paths but leaves a real coverage gap:

| Exit path | Reverter ran? |
|---|---|
| SIGTERM / SIGINT (graceful quit, Tauri Cmd-Q) | ✓ via `initiateShutdown` |
| `process.exit(n)` from anywhere | ✓ since this ADR — via `exit` event safety net |
| Uncaught exception | ✓ since this ADR — via `exit` event |
| Tauri shell crashed | ✓ via parent-pid watchdog → `initiateShutdown` |
| **SIGKILL** | ✗ no userspace runs |
| **OS-level kill (OOM, force-quit -9)** | ✗ no userspace runs |
| **OS reboot / power loss** | ✗ no userspace runs |

For the bottom three, no in-process fix is possible: when the
process dies without warning, the reverter cannot run. The base URL
persists in settings.json across the gap, and the user's next
`claude` invocation fails until they manually intervene OR the next
`maximal start` re-applies the URL on top of an alive proxy.

## Decision

Land the in-process improvements (this PR), document the inter-
session gap, and **defer the structural fix** (an external
watchdog) to a separate effort with an explicit revisit trigger.

### Shipped in this PR

1. **`exit` event safety-net reverter** in
   `src/lib/start/shutdown.ts`. Node fires `exit` on
   `process.exit(n)`, uncaught exceptions, and natural exits — none
   of which currently route through `initiateShutdown`. The
   reverter is synchronous and idempotent.

2. **Session sentinel** in `src/lib/start/session-sentinel.ts`. On
   boot, write a marker file. On graceful shutdown (either path),
   delete it. On the *next* boot, if the marker is still there from
   a prior session, the previous run died ungracefully — log a
   clear, user-facing warning that correlates the symptom they
   likely just experienced ("`claude` was broken") with the cause.
   Doesn't auto-recover the inter-session window — diagnoses it.

3. **Tests:** ten `tests/session-sentinel.test.ts` cases covering
   write / clear / detect / idempotency / error-swallowing / the
   crash-detection contract (graceful → no stale marker,
   ungraceful → stale marker present).

### Deferred to a separate effort

An **external watchdog** that can revert the base URL even when the
maximal process is dead. Two viable shapes:

**(A) launchd-managed reaper.** A small per-user `launchd` agent
that runs every ~30s, probes `localhost:<port>`, and toggles the
base URL based on liveness. Pros: completely independent of
maximal's process; survives crashes, reboots, OOM. Cons: a new
component to install, sign, and maintain; needs to know maximal's
port; needs to know the same ownership-guarded write logic that's
currently in TypeScript (likely a shell script or a tiny Swift
binary).

**(B) Tauri shell observes sidecar death.** The Rust shell already
holds the sidecar `CommandChild` and tracks the `Failed` tray
state. On the Starting → Failed transition (or any sidecar exit
the shell wasn't expecting), call the revert helper. Cons: only
covers cases where the Tauri shell is running. A user who uses
maximal from the CLI without the menu-bar app gets no benefit.
Also duplicates the ownership-guarded write logic in Rust.

Recommendation when revisiting: **(A) is the better long-term
shape** — it covers all users symmetrically. Combine with (B)
defense-in-depth if the menu-bar audience has a faster-recovery
requirement than 30s.

### Revisit triggers

Re-open the structural fix when any of:

1. A user reports the inter-session symptom *after* this PR ships.
   The boot-time stale-session warning will make it findable in
   support reports.
2. Telemetry (if added) shows the sentinel marker present at boot
   in >5% of cold starts. That's the empirical signal that
   ungraceful exits are common enough to justify a watchdog.
3. A third app integration (per ADR-0009) wants the same dynamic-
   routing guarantee. At that point, build it once for everyone.

## Alternatives considered (and rejected here)

- **Re-introduce a shim** that probes localhost before exec'ing
  `claude`. Sidesteps the issue cleanly but resurrects ADR-0003's
  closed door (version pinning, PATH races, process-name identity
  guards). The pre-v0.4.13 shim's failure modes were the reason
  for the settings.json pivot in the first place. Don't go back
  without a much better shim design.
- **Auto-disable routing intent on every shutdown.** Trivial code
  change (`apps.claudeCode.enabled = false` in
  `reconcileClaudeCodeOnShutdown`). Trades "set-and-forget routing"
  for "no breakage on down" at significant UX cost — users would
  re-enable on every restart. Not the right default.
- **Add a `maximal doctor` CLI** that detects + reverts a stale
  URL. Useful as a manual escape hatch, but the user has to
  *know* to run it. Doesn't fix the discoverability problem; the
  boot-time warning is a better first step. (A `doctor` subcommand
  is still worth adding later — out of scope here.)
- **Cripple settings.json by writing a base URL that maximal
  cycles** with a timestamp marker `claude` could ignore. `claude`
  doesn't know about our marker. Dead-end.

## Consequences

- Graceful exits cover three more paths than before
  (`process.exit`, uncaught exceptions, unhandled rejections).
- Users hitting the inter-session symptom now see a clear warning
  on the next `maximal start` instead of being silently surprised.
  The cause is correlatable from the warning text.
- The SIGKILL / OS-reboot inter-session gap remains. Documented
  here; will be revisited when one of the triggers fires.
- A new test file (`tests/session-sentinel.test.ts`) and one new
  source file (`src/lib/start/session-sentinel.ts`). No public API
  changes; `~/start`'s exports are unchanged.

## Out of scope

- The structural watchdog. Deferred per the criteria above.
- A `maximal doctor` CLI. Worth adding when there's a clear list
  of things it should check; not justified by this issue alone.
- Changing the settings.json approach back to a shim. ADR-0003 is
  authoritative until we have a much better shim design than the
  previous attempt.
