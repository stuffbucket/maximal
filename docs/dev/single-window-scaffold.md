# Single-window redesign — code scaffold index

Status: scaffolding pass, 2026-07-14. Tracks the plan in
[`docs/spec/single-window-redesign.md`](../spec/single-window-redesign.md) and
ADR-0018…0021.

This pass wires **shapes only** — module boundaries, types, constants, and
function signatures — with bodies stubbed via `notImplemented(...)`. Everything is
**additive**: no existing module (`server.ts`, `run-server.ts`, `main.ts`) is
edited, so the 1477-test suite stays green. Each stub delegates to
`src/lib/dev/not-implemented.ts` / `shell/src/dev/not-implemented.ts` — grep
`notImplemented(` to enumerate every body still to fill in.

## New modules & where they wire in

| Module | Spec | Integration point (NOT yet wired) |
|---|---|---|
| `src/lib/ws/tray-open.ts` | §1.2 | pure `decideTrayOpen` — called by the presence registry + the tray-open orchestrator |
| `src/lib/ws/presence-registry.ts` | §1.2 | one instance in `run-server.ts`; identity-checked `remove` is the mutation anchor |
| `src/lib/ws/feed-types.ts` | §1.3 | wire contract shared by sidecar **and** shell (relative import, DOM-free) |
| `src/lib/ws/live-feed.ts` | §1.3 | `LiveFeedHub` constructed in `run-server.ts`; `start()` after sidecar up |
| `src/routes/ws/route.ts` | §1.3 | mount `createWsRoutes()` on the app at `WS_PATH`; pass `createWebSocketHandler(...)` into `serve({ bun: { websocket } })` in `run-server.ts`. **srvx-upgrade gate: PROVEN** — a real WebSocket connects through the srvx→Bun upgrade; the `undefined` return after `server.upgrade()` survives Hono + srvx + Bun with no coercion (no plugin fallback needed). The `GET` upgrade + minimal non-throwing WS callbacks are wired; presence/hub logic in the callbacks is still TODO. |
| `src/lib/auth/origin-guard.ts` | §6.1 | mount `createOriginGuardMiddleware` in `server.ts` **before** the sub-app routes; swap `cors()` for `buildCorsOptions(...)`. §6.2 (mandatory `/settings/api` auth) is **not** here — deliver it as an always-enforce mode of the existing `createAuthMiddleware` so the `shellApiKey` bypass + attribution stay single-sourced |
| `src/routes/ui/inline-state.ts` | §1.4 | call `injectInlineState` inside `serve()` in `src/routes/ui/route.ts` when `isHtmlResponse(hit.type)` |
| `shell/src/router.ts` | §1.4 / ADR-0020 | DOM-free router core; `history.replaceState` only |
| `shell/src/router-bootstrap.ts` | §1.4 | DOM glue: reads `window`, calls `createRouter`; replaces hash routing in `main.ts` |
| `shell/src/proxy/live-feed-core.ts` | §1.2–1.3 | DOM-free helpers (tab id, URL, backoff, frames) |
| `shell/src/proxy/live-feed-client.ts` | §1.2–1.3 | WebSocket/DOM glue; replaces `subscribeAuthEvents` in `client.ts` |
| `shell/src/ui/nav/project-slice.ts` | §2.2–2.3 | pure `curateProjectSlice` — feeds the Projects rail group |

## Test map (§10 gates)

Behavioral suites are authored and **`describe.skip`-gated** — remove `.skip` when
the matching body lands. Contract/shape/grep tests run **live now**.

| Test | Live now? | Unskip when |
|---|---|---|
| `tests/ws/tray-open-decision.test.ts` | skip | `decideTrayOpen` |
| `tests/ws/presence-registry.test.ts` | partial (`size`) | registry methods |
| `tests/ws/live-feed-contract.test.ts` | **live** | — (guards the 9-event coverage) |
| `tests/ws/srvx-upgrade-handshake.test.ts` | **PROVEN**, runs in the default suite (`start-run-server.test.ts` now injects its `serve` stub via `__setServeForTests` instead of mocking srvx, so the two co-run; `mockModuleLeakGuard` forbids re-adding `mock.module("srvx", …)`) | — |
| `tests/ws/live-feed-core.test.ts` | skip | core helpers |
| `tests/security/origin-guard.test.ts` | partial (consts) | guard middleware |
| `tests/security/settings-api-route-enumeration.test.ts` | partial (enum) | guard wired into `server.ts` |
| `tests/security/cli-client-regression.test.ts` | skip | guard middleware |
| `tests/ui/inline-state.test.ts` | skip | inline-state fns |
| `tests/spa-router.test.ts` | skip | `createRouter` |
| `tests/single-history-invariant.test.ts` | **live** | — (grep gate; add `main.ts`/`dashboard/main.ts` to `ROUTING_SOURCES` after the SPA/dashboard port) |
| `tests/project-slice.test.ts` | skip | `curateProjectSlice` |

## Notes for the implementer

- **`knip` (check:deep)** will report the new exports as unused-in-production until
  the integration points above are wired — expected during scaffolding.
- **Mutation targets** (`stryker.conf.json` `mutate`, one module at a time):
  `src/lib/ws/tray-open.ts`, then `presence-registry.ts` (the identity guard),
  then `src/lib/auth/origin-guard.ts` (the `isAllowedOrigin` / enforce-decoupling).
- **No jsdom.** DOM-touching shell code is split into a DOM-free core (imported +
  unit-tested) and thin `*-bootstrap` / `*-client` glue (source-grepped only).
  Keep that split when filling bodies in.
- **The `?key=` allowlist** (`request-auth.ts` `SSE_EVENTS_PATH`) must **move** to
  `WS_PATH` when the WS lands — it is a single hardcoded path today.
