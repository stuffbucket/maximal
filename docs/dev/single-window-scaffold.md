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
| `src/lib/ws/live-feed.ts` | §1.3 | **WIRED (Build Track 2):** `LiveFeedHub.start/stop/publish` bridge the settings event bus (`auth.changed`) → wrapped feed events broadcast to all tabs (idempotent; the other 8 event types await their producers). `buildSnapshot()` composes the 9 snapshot fields from the extracted GET builders (`buildAccountsList`/`buildAppsList`) + `getAuthStatus`/`listActiveClients`/`getTokenUsageSummary`/`getUpdateStatus`. One hub + registry are constructed in `run-server.ts` (`createLiveFeed`) and `hub.start()` runs in `finalizeBoot` after the bind. |
| `src/routes/ws/route.ts` | §1.3 | **WIRED (Build Track 2):** `createWsRoutes()` is mounted at `WS_PATH` in `server.ts` (Origin-gated + `?key=`-exempt from the API-key middleware), and `createWebSocketHandler(...)` is passed into `serve({ bun: { websocket } })` by `run-server.ts` (`createLiveFeed`). **srvx-upgrade gate: PROVEN.** Callbacks: `open`→authcheck + snapshot-on-connect, `message`→`hello`/`visibility`/`pong` drive the presence registry, `close`→identity-checked remove; the handshake GET catches a non-upgrade probe → clean 426. Covered by `tests/ws/ws-handler.test.ts`. |
| `src/lib/auth/origin-guard.ts` | §6.1 | **DONE (Build Track 1):** `createOriginGuardMiddleware` + narrowed `buildCorsOptions(...)` are mounted in `server.ts` before the sub-app routes; the bound port is read lazily from `state.boundPort` (set by `runServer`, default 4141). §6.2 (mandatory `/settings/api` auth) is delivered as the `alwaysEnforcePrefixes` mode of the existing `createAuthMiddleware`, so the `shellApiKey` bypass + attribution stay single-sourced; the read-only `/settings/api/diagnostics` GET is exempt (§1.7/§6.5) and CSRF-safe via the Origin guard |
| `src/routes/ui/inline-state.ts` | §1.4 | **Bodies implemented (Track-4 groundwork):** `renderStateScript` (XSS-safe `<`/U+2028/U+2029 escaping), `isHtmlResponse`, `injectInlineState` (before `</head>`, never drops state). `buildInlineUiState` composes `buildSnapshot` (the inlined `__STATE__` IS the WS snapshot) with TODO-sourced token/locale/dismissal. **Still to wire:** call `injectInlineState` inside `serve()` in `src/routes/ui/route.ts` when `isHtmlResponse(hit.type)` — deferred to the SPA track (it calls `buildSnapshot()` per HTML serve, so it lands with the consumer). |
| `shell/src/router.ts` | §1.4 / ADR-0020 | **Body implemented (Track-4 groundwork):** DOM-free `createRouter` (replaceState-only, single-history), `defaultSection`/`isSectionId`/`readSectionFromLocation`/`readProjectSlug`/`targetUrl`. Still to wire: `router-bootstrap.ts` DOM glue replacing `main.ts` hash routing |
| `shell/src/router-bootstrap.ts` | §1.4 | DOM glue: reads `window`, calls `createRouter`; replaces hash routing in `main.ts` |
| `shell/src/proxy/live-feed-core.ts` | §1.2–1.3 | DOM-free helpers (tab id, URL, backoff, frames) |
| `shell/src/proxy/live-feed-client.ts` | §1.2–1.3 | WebSocket/DOM glue; replaces `subscribeAuthEvents` in `client.ts` |
| `shell/src/ui/nav/project-slice.ts` | §2.2–2.3 | **Body implemented (Track-5 groundwork):** pure `curateProjectSlice` (pinned-first, recency-filled, hard-capped) — feeds the Projects rail group; consumed by the nav render when Track 5 lands |

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
| `tests/ws/live-feed-hub.test.ts` | **live** — hub start/stop/publish over the settings bus (real registry) | — |
| `tests/security/origin-guard.test.ts` | **live** — guard implemented + mounted (§6.1–6.2); origin-guard.ts mutation score 88% (message wording deliberately unpinned) | — |
| `tests/security/settings-api-route-enumeration.test.ts` | **live** — every mutating `/settings/api` route asserts 403 to an evil Origin (self-extending) | — |
| `tests/security/cli-client-regression.test.ts` | **live** — no-Origin `Bearer` on `/v1/*` still 200 (§6.6) | — |
| `tests/ui/inline-state.test.ts` | **live** — escaping/isHtmlResponse/injectInlineState implemented (XSS anchor); `buildInlineUiState` composes `buildSnapshot` (unwired) | wiring into `route.ts` |
| `tests/spa-router.test.ts` | **live** — `createRouter` implemented (replaceState-only, single-history) | — |
| `tests/single-history-invariant.test.ts` | **live** | — (grep gate; add `main.ts`/`dashboard/main.ts` to `ROUTING_SOURCES` after the SPA/dashboard port) |
| `tests/project-slice.test.ts` | **live** — `curateProjectSlice` implemented (caps rail at N=0/3/6/7/50, pinned-first) | — |

## Notes for the implementer

- **`knip` (check:deep)** now passes for the WS surface — the Track-2 exports are
  all wired. One scaffold export remains flagged: `buildInlineUiState`
  (`src/routes/ui/inline-state.ts`, §1.4 instant-paint) — expected until the SPA
  track wires it. Don't treat that single knip finding as a regression.
- **Mutation targets** (`stryker.conf.json` `mutate`, one module at a time):
  `src/lib/ws/tray-open.ts` and `presence-registry.ts` (the identity guard) are
  **done — both 100%** (Build Track 2, 2026-07-15). `src/lib/auth/origin-guard.ts`
  was mutation-checked at Build Track 1 (88%; the only survivors are the 403
  message wording, deliberately unpinned). `src/routes/ui/inline-state.ts` is at
  79% — the security-critical serialization (`renderStateScript` escaping +
  `injectInlineState` placement) is 100%-killed; the only survivors are the
  unwired `buildInlineUiState` composer (its real test lands with the route wiring).
- **No jsdom.** DOM-touching shell code is split into a DOM-free core (imported +
  unit-tested) and thin `*-bootstrap` / `*-client` glue (source-grepped only).
  Keep that split when filling bodies in.
- **The `?key=` allowlist** (`request-auth.ts` `SSE_EVENTS_PATH`) still points at
  the SSE path — it has NOT moved yet, because the SSE route lives until the
  transport-migration cleanup (Track 7). `WS_PATH` is instead exempted from the
  API-key middleware (`allowUnauthenticatedPaths`) and protected by the Origin
  guard + its own `?key=` presence check; validating that `?key=` as a **minted
  session token** (§6.5) is the pending piece and depends on the token being
  inlined into the served HTML (Track 4). Move/retire the SSE `?key=` when the SSE
  route is deleted.
