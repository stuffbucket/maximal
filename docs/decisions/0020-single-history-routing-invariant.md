---
id: ADR-0020
title: Single-history (replaceState-only) routing invariant
status: proposed
date: 2026-07-14
authors:
  - stuffbucket
supersedes: []
links:
  spec: docs/spec/single-window-redesign.md
  shell_entry: shell/src/main.ts
  token_drift_gate: scripts/check-design-tokens.ts
---

# Single-history (replaceState-only) routing invariant

## Context

Browser-tab delivery (ADR-0018) relies on the sidecar commanding a stale tab
to `window.close()` over the WebSocket (ADR-0019). Empirically (Safari **and**
Edge), `window.close()` on a user/native-opened tab **silently no-ops the
moment `history.length > 1`** — WebKit/Chromium both gate self-close on the
back/forward list having a single entry.

The current SPA is hash-navigated: it **assigns `window.location.hash`** on
every section switch, which pushes a history entry. ADR-0004 decided
*"hash-nav routing stays in `main.ts` (no React Router)"* and listed
*"replacing hash-nav with a router"* out of scope; ADR-0002 wired a
`hashchange` listener to reset the api-clients island. Both accrue history and
would silently break stale-tab self-close.

## Decision

The served UI **MUST keep `history.length === 1`**. All in-app navigation goes
through a single `navigate(id)` using **`history.replaceState`** — **never
`pushState`, never `location.hash =`**. The `#section` deep-link contract may
remain *if* navigation stops *assigning* the hash (read it on boot only);
per-project detail routing uses an **open-time `?param`** + `replaceState`,
not hash accrual.

`navigate(id)` absorbs the side effects currently driven by the `hashchange`
listener (section load/refresh, `closeAuthEvents`, and **ADR-0002's
api-clients `selectMode` reset**).

This **amends ADR-0004** (overturns its hash-nav-stays decision; the
React-islands architecture itself stands) and **ADR-0002** (its `hashchange`
reset moves into `navigate(id)`).

## Alternatives considered

- **A pushState-based router (react-router, etc.).** Grows history →
  self-close breaks on the second navigation. Rejected outright.
- **Accept duplicate tabs.** Defeats the single-tab guarantee that is the
  whole point of ADR-0018. Rejected.
- **PWA/native focus to avoid needing self-close.** Rejected in ADR-0018.

## Consequences

- A routing refactor: three hash-assigning nav paths (`wireNav`, `navLink`,
  boot sync) collapse to `navigate(id)`; `readHashSection` survives only for
  boot/deep-link resolution.
- A **build-failing CI gate** (spec §10): a grep test banning `pushState` /
  `location.hash =` in nav sources, plus a behavioral test driving the router
  against a fake `History` and asserting `length === 1` / `pushes === 0`.
- A live offender must go: `shell/src/dashboard/main.ts:337` calls
  `history.pushState` — removed with the dashboard port.
- Any dependency that pushState-navigates is banned; the behavioral gate
  catches it at runtime, the grep gate at commit.

## Out of scope

- Adopting a routing library.

## Open questions

- Keep `#section` fragments (cosmetic, deep-link-friendly) vs. move fully to
  `?section=` open-time params. Either satisfies the invariant.
