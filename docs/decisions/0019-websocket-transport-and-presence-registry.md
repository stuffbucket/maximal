---
id: ADR-0019
title: WebSocket transport + presence registry (supersedes SSE)
status: proposed
date: 2026-07-14
authors:
  - stuffbucket
supersedes:
  - ADR-0007
links:
  spec: docs/spec/single-window-redesign.md
  sse_events: src/routes/settings/events.ts
  request_auth: src/lib/auth/request-auth.ts
  run_server: src/lib/start/run-server.ts
  shell_lib: shell/src-tauri/src/lib.rs
---

# WebSocket transport + presence registry (supersedes SSE)

## Context

ADR-0007 added an SSE channel (`GET /settings/api/events`) and **explicitly
rejected WebSockets**, on the stated grounds that *"the shell never needs to
push state — it acts via existing POST endpoints,"* and scoped it to *"one
shell, one connection."*

Browser-tab delivery (ADR-0018) invalidates both premises:

- **The client now must push state.** The sidecar owns the browser tab
  lifecycle; it needs each tab to report presence + `visibilityState`, and it
  sends a tab a `{cmd:close}` to replace a stale one. That is a client↔server
  push protocol SSE cannot carry.
- **It is inherently multi-subscriber.** Multiple app tabs may exist
  transiently, plus N independently-opened read-only `/ui/diagnostics` pages.

So ADR-0007's transport choice *and* its subscriber scope are void — not
merely dated.

## Decision

Introduce **one WebSocket** as the shell↔UI transport, replacing SSE, the
Tauri usage `Channel` (`subscribe_token_usage`), and Rust `emit`. It carries:

1. **The presence registry** — tabs register a client-generated `tabId`
   (`sessionStorage`) + `visibilityState`; the sidecar drives the single-tab
   open/replace decision (ADR-0018, spec §1.2).
2. **The unified live feed** — **all six ADR-0007 event types**
   (`auth.changed`, `accounts.changed`, `apps.changed`, `clients.changed`,
   `upstream.rejection`, `boot.state`) **plus** `usage`, `update-available`,
   and `sidecar-health`.

Implementation: **Bun-native `Bun.serve` WebSocket through srvx's
`bun:{ websocket }` passthrough — no `crossws`, no srvx fork, zero new
dependency** (the sidecar is always Bun; cross-runtime abstraction buys
nothing). Loopback-only + path-scoped `?key=` auth (the `SSE_EVENTS_PATH`
`?key=` allowlist in `request-auth.ts` moves to the WS path). Heartbeat/
ping-pong liveness; reconnect-on-`visibilitychange`; full snapshot on
(re)connect. Endpoint on the discovered bound port (ADR-0018).

## Alternatives considered

- **Keep SSE, add a side channel for presence.** Two transports for one job;
  SSE still can't carry client→server push cleanly. Rejected.
- **`crossws`.** A cross-runtime WS abstraction (~244 KB, multi-runtime
  adapters); we only ever run on Bun, so it adds weight for portability we
  don't use. Rejected in favor of Bun-native.
- **Tauri `emit`/`listen`.** Dead in a browser tab (no Tauri host). Rejected.

## Consequences

- Retires `src/routes/settings/events.ts` (SSE) and the Tauri `Channel` +
  `TokenUsageEvent`; the auth subscription becomes page-lifetime (updates
  ADR-0007's section-scoped model).
- Registry correctness needs an **identity-checked delete**
  (`if map.get(id) === ws`) or a reconnect desyncs it; mutation-tested.
- **Safari tears down a backgrounded tab's WS after ~5 min** — a
  long-buried tab can transiently duplicate and **self-heals** on refocus
  (Chromium keeps warm sockets). Accepted, bounded by a liveness deadline.
- **One gate to prove first — PROVEN (2026-07-14):** srvx's fetch-wrapper must
  tolerate the `undefined` return after `server.upgrade()`; if it coerces to a
  `Response`, the handshake silently fails. A real-port test
  (`tests/ws/srvx-upgrade-handshake.test.ts`) confirms a genuine WebSocket
  connects through the srvx→Bun upgrade: srvx returns the Hono `app.fetch` result
  straight to Bun with no coercion (`node_modules/srvx/dist/adapters/bun.mjs:50`),
  so the `undefined` survives. **The fallback (a srvx plugin that upgrades before
  Hono) is not needed.** The test is gated behind `MAXIMAL_TEST_WS=1` because it
  cannot co-run with `start-run-server.test.ts`'s srvx `mock.module`.

## Migration

Spec §1.2–1.3, §7. Per ADR-0012, the connect/reconnect/snapshot and tray-open
dedup flows each need a state-matrix doc; the account-switch reboot matrix is
directly touched (`boot.state`).

## Out of scope

- Replay / event sourcing (snapshot-on-connect + live events is enough).

## Open questions

- The srvx-upgrade-wrapper gate (above) — settle in build step 1.
- Safari background-teardown convergence: eager eviction on `ping` timeout vs
  lazy heal on refocus.
