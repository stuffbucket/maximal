# PRD: Usage, Status & Control Surfaces (Wire)

The non-completion endpoints: liveness/identity, setup probe, Copilot
quota, the proxy's own token-usage ledger, the raw token, the debug
dump, and the shutdown control. Read
[`auth-transport-wire-prd.md`](auth-transport-wire-prd.md) first for the
auth/loopback model these inherit.

## Endpoint map

| Method | Path | Auth class | Content-Type |
|---|---|---|---|
| `GET` | `/status` | unauthenticated | `application/json` |
| `GET` | `/setup-status` | unauthenticated | `application/json` |
| `GET` | `/usage` | loopback-only | `application/json` |
| `GET` | `/token-usage` | loopback-only | `application/json` |
| `GET` | `/token-usage/events` | loopback-only | `application/json` |
| `GET` | `/_debug/state` | unauthenticated, `verbose`-gated, CSRF-guarded | `application/json` |
| `POST` | `/_internal/shutdown` | loopback-only (+ in-handler enforce), CSRF-guarded | `application/json` |
| `POST` | `/_internal/quit` | loopback-only (+ in-handler enforce), CSRF-guarded | `application/json` |
| `POST` | `/_internal/tray-open` | loopback-only (+ in-handler enforce), CSRF-guarded | `application/json` |
| `POST` | `/_internal/upgrade` | loopback-only (+ in-handler enforce), CSRF-guarded | `application/json` |

The old `GET /token` (raw Copilot bearer token) endpoint was **removed**
(#240, security fix — it leaked the raw Copilot token to any caller that
could reach loopback). There is no replacement; nothing in the current
tree serves the raw token over HTTP.

"CSRF-guarded" means the prefix is in `CSRF_GUARDED_PREFIXES`
(`src/lib/auth/origin-guard.ts`, ADR-0021 / spec §6): a present,
non-localhost `Origin` header gets `403 csrf_error` before the
loopback/auth check even runs. See `auth-transport-wire-prd.md`.

(The standalone `/ui/dashboard` window is gone — single-window redesign,
ADR-0018 (browser-tab UI delivery). Its usage view now lives at
`/ui/settings/#usage`, served by `src/routes/ui/route.ts` with the same
`no-store` treatment the old dashboard assets had.)

## `/status` — identity + liveness

Cheap, in-memory, no upstream call (`src/lib/runtime-state/status.ts`). This is
the unambiguous "is the thing on this port actually Maximal, and is it
ready?" probe the Claude Code shim keys off `service: "maximal"`.

```json
{
  "service": "maximal",
  "status": "ok",
  "version": "0.4.x",
  "uptime_ms": 123456,
  "subsystems": {
    "copilot": { "authenticated": true, "ready": true, "account_type": "individual" },
    "models":  { "cached": 42 }
  }
}
```

Safe-for-unauth: booleans/tiers/counts only, never secrets.
`subsystems` namespaces per-part health so new subsystems slot in without
reshaping the contract.

## `/setup-status` — first-run readiness

`src/routes/setup-status.ts` (route) / `src/lib/config/setup-status.ts`
(logic). Unauthenticated by design (must work before any key exists).

```json
{
  "ready": false,
  "checks": {
    "appDir":     { "ok": true,  "path": "~/.local/share/maximal" },
    "config":     { "ok": true,  "path": ".../config.json" },
    "db":         { "ok": true },
    "githubAuth": { "ok": false, "reason": "github_token missing" }
  },
  "nextStep": "githubAuth"
}
```

`ready = all(checks.ok)`; `nextStep` is the first failing check in
canonical order (`appDir → config → db → githubAuth`) or `null`.

## `/usage` — Copilot quota

Loopback-only. Returns the upstream `CopilotUsageResponse`
(`src/services/github/get-copilot-usage.ts`): `login`,
`copilot_plan`, `quota_reset_date`, and `quota_snapshots` for `chat`,
`completions`, and `premium_interactions` — each a `QuotaDetail`
(`entitlement`, `remaining`, `percent_remaining`, `quota_remaining`,
`overage_count`, `overage_permitted`, `unlimited`, `quota_id`), plus
`endpoints.{api,telemetry}`.

## `/token-usage` — the proxy's own ledger

Loopback-only. Aggregates the locally-recorded token-usage events (every
completion across all surfaces records one) for a period.

- **Query:** `period` ∈ `day` | `week` | `month` (default `day`).
- **Response** — `TokenUsageSummary`
  (`src/lib/token-usage/store.ts`): `period`, `range`
  (`start_ms`/`end_ms` + `_utc` ISO strings), `totals`, and `byModel[]`.
  `totals`/`byModel` entries carry `request_count`, `input_tokens`,
  `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, `total_tokens` (and `model` per entry).

Periods are UTC-aware: day = calendar day; week = Mon–Sun (ISO);
month = 1st–last.

## `/token-usage/events` — paginated event log

Loopback-only. **Despite the name, this is a paginated JSON endpoint, not
an SSE stream** (`src/routes/token-usage/route.ts`).

- **Query:** `period` (as above); `page` (1-indexed, default `1`);
  `page_size` (default `20`, clamped to `[1, 100]`).
- **Response** — `TokenUsageEventsPage` (`store.ts`): `items[]`,
  `page`, `page_size`, `total`, `total_pages`, `period`, `range`. Each
  `TokenUsageEventRecord` has `id`, `created_at_ms`/`_utc`, `trace_id`,
  `session_id`, `user_id`, `source` (`copilot`|`provider`), `endpoint`
  (`chat_completions`|`embeddings`|`messages`|`provider_messages`|
  `responses`), `provider_name`, `model`, and the token counts.

### Data model behind it

Recording is an **in-process** event bus, not a wire concern: callers
emit `token_usage.recorded` with a `PersistedTokenUsageEvent`, a
subscriber enqueues a SQLite write to `token_usage_events`
(`src/lib/token-usage/index.ts`, `store.ts`). Normalizers
coerce missing/non-finite counts to `0`, unknown model → `"unknown"`,
and resolve session ID from request-context → input → fallback. (The
live feed the settings UI uses is the unified `/ws` WebSocket — see
ADR-0019 (WebSocket transport + presence registry) — not this endpoint.)

## `/_debug/state` — live diagnostics

Unauthenticated **but gated**: returns `404` unless `state.verbose` is
true (`src/routes/debug/route.ts`); also CSRF-guarded (a cross-origin
browser request 403s before the verbose check runs). The live equivalent
of `maximal debug`. Body bundles `git`, `runtime`
(`account_type`, `verbose`, `manual_approve`, rate-limit settings,
`models_loaded`/`models_count`, `copilot_token_present`,
`github_token_present`), `config` (summarized), `executor`, `caches`
(metrics), and `secrets` (sources only, never values). The same payload,
built by the same `buildDebugState()`, also backs the unauthenticated
`/ui/diagnostics` read-only page (§1.7) — the `verbose` gate is a
property of this route, not of the data.

## `/_internal/*` — process-control endpoints

All four are loopback-only (each handler independently re-checks
`isLoopbackAddress()` and 404s a remote caller regardless of a valid API
key) and CSRF-guarded (`src/routes/internal/route.ts`):

- **`POST /_internal/shutdown`** — graceful eviction, used by a second
  `maximal start --replace` invocation to ask the running instance to
  release its port. Optional body `{ "reason"?: string }` (logged;
  parse errors ignored). Returns `202 { ok: true, draining: true }`; the
  process exits `0` after a 250ms delay so the response can flush.
- **`POST /_internal/quit`** — the browser-tab UI's quit path (it has no
  Tauri host to `invoke` a quit). Returns `202 { ok: true, quitting: true }`
  when a shell is listening, `409 { ok: false, reason: "no_supervising_shell" }`
  for a plain-CLI run.
- **`POST /_internal/tray-open`** — the native tray click routes here: the
  sidecar owns the browser tab set and runs the single-tab decision
  (close buried tabs over `/ws`, tell the shell whether to open one fresh
  foreground tab). Returns the `orchestrateTrayOpen()` result.
- **`POST /_internal/upgrade`** — the browser-tab UI's in-place
  self-update path (Phase 6): POSTs here and the sidecar signals the
  supervising shell to run the signed download+verify+install+relaunch.
  Returns `202 { ok: true, upgrading: true }` when a shell is listening,
  `409 { ok: false, reason: "no_supervising_shell" }` otherwise (the UI
  falls back to the download page).

## Acceptance

1. `GET /status` returns `service: "maximal"` with `subsystems` health,
   unauthenticated, with no upstream call.
2. `GET /usage` and `/token-usage` succeed from loopback without a key
   and `401` from a remote caller without one.
3. `GET /token-usage/events?page=2&page_size=50` returns a
   `TokenUsageEventsPage` (JSON, not SSE) with `page_size` clamped to
   `[1,100]` and correct `total_pages`.
4. `GET /_debug/state` returns `404` unless `verbose` is set; it never
   includes secret values; a cross-origin browser request 403s
   regardless of `verbose`.
5. `POST /_internal/shutdown` from loopback returns `202`
   `{ok,draining}` and the process exits shortly after; the same from a
   remote peer returns `404`.
6. `POST /_internal/quit`, `/_internal/tray-open`, and
   `/_internal/upgrade` each 404 a non-loopback caller and 403 a
   cross-origin browser request (present, non-localhost `Origin`).
