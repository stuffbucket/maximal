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
| `src/routes/ws/route.ts` | §1.3 | mount `createWsRoutes()` on the app at `WS_PATH`; pass `createWebSocketHandler(...)` into `serve({ bun: { websocket } })` in `run-server.ts`. **srvx-upgrade gate: PROVEN** — a real WebSocket connects through the srvx→Bun upgrade; the `undefined` return after `server.upgrade()` survives Hono + srvx + Bun with no coercion (no plugin fallback needed). **Callbacks now wired (Build Track 2):** `open`→authcheck + snapshot-on-connect, `message`→`hello`/`visibility`/`pong` drive the presence registry, `close`→identity-checked remove. Covered by `tests/ws/ws-handler.test.ts` (fake sockets + real registry + a `LiveFeedHub` with an injected snapshot builder). Still not wired into `run-server.ts`. |
| `src/lib/auth/origin-guard.ts` | §6.1 | **DONE (Build Track 1):** `createOriginGuardMiddleware` + narrowed `buildCorsOptions(...)` are mounted in `server.ts` before the sub-app routes; the bound port is read lazily from `state.boundPort` (set by `runServer`, default 4141). §6.2 (mandatory `/settings/api` auth) is delivered as the `alwaysEnforcePrefixes` mode of the existing `createAuthMiddleware`, so the `shellApiKey` bypass + attribution stay single-sourced; the read-only `/settings/api/diagnostics` GET is exempt (§1.7/§6.5) and CSRF-safe via the Origin guard |
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
| `tests/ws/tray-open-decision.test.ts` | **live** — `decideTrayOpen` implemented; mutation score 100% | — |
| `tests/ws/presence-registry.test.ts` | **live** — registry implemented (identity-checked delete); mutation score 100% | — |
| `tests/ws/live-feed-contract.test.ts` | **live** | — (guards the 9-event coverage) |
| `tests/ws/srvx-upgrade-handshake.test.ts` | **PROVEN**, runs in the default suite (`start-run-server.test.ts` now injects its `serve` stub via `__setServeForTests` instead of mocking srvx, so the two co-run; `mockModuleLeakGuard` forbids re-adding `mock.module("srvx", …)`) | — |
| `tests/ws/live-feed-core.test.ts` | **live** — DOM-free client core implemented (tab-id/URL/backoff/parse/serialize) | — |
| `tests/ws/ws-handler.test.ts` | **live** — handler callbacks wire the registry + snapshot (open/message/close) | — |
| `tests/security/origin-guard.test.ts` | **live** — guard implemented + mounted (§6.1–6.2); origin-guard.ts mutation score 88% (message wording deliberately unpinned) | — |
| `tests/security/settings-api-route-enumeration.test.ts` | **live** — every mutating `/settings/api` route asserts 403 to an evil Origin (self-extending) | — |
| `tests/security/cli-client-regression.test.ts` | **live** — no-Origin `Bearer` on `/v1/*` still 200 (§6.6) | — |
| `tests/ui/inline-state.test.ts` | skip | inline-state fns |
| `tests/spa-router.test.ts` | skip | `createRouter` |
| `tests/single-history-invariant.test.ts` | **live** | — (grep gate; add `main.ts`/`dashboard/main.ts` to `ROUTING_SOURCES` after the SPA/dashboard port) |
| `tests/project-slice.test.ts` | skip | `curateProjectSlice` |

## Notes for the implementer

- **`knip` (check:deep)** will report the new exports as unused-in-production until
  the integration points above are wired — expected during scaffolding.
- **Mutation targets** (`stryker.conf.json` `mutate`, one module at a time):
  `src/lib/ws/tray-open.ts` and `presence-registry.ts` (the identity guard) are
  **done — both 100%** (Build Track 2, 2026-07-15). `src/lib/auth/origin-guard.ts`
  was mutation-checked at Build Track 1 (88%; the only survivors are the 403
  message wording, deliberately unpinned).
- **No jsdom.** DOM-touching shell code is split into a DOM-free core (imported +
  unit-tested) and thin `*-bootstrap` / `*-client` glue (source-grepped only).
  Keep that split when filling bodies in.
- **The `?key=` allowlist** (`request-auth.ts` `SSE_EVENTS_PATH`) must **move** to
  `WS_PATH` when the WS lands — it is a single hardcoded path today.
