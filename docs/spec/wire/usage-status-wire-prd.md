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
| `GET` | `/token` | API-key (default chain) | `application/json` |
| `GET` | `/_debug/state` | unauthenticated, `verbose`-gated | `application/json` |
| `POST` | `/_internal/shutdown` | loopback-only (+ in-handler enforce) | `application/json` |

(Dashboard assets — `/usage-viewer*`, `/vendor/*` — are served
`no-store`; they are UI, not a wire contract, and are out of scope here.)

## `/status` — identity + liveness

Cheap, in-memory, no upstream call (`src/lib/status.ts:48-93`). This is
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

`src/lib/setup-status.ts:36-90`. Unauthenticated by design (must work
before any key exists). See `docs/first-run-setup-prd.md` for the
consuming UI.

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
(`src/services/github/get-copilot-usage.ts:47-63`): `login`,
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
  (`src/lib/token-usage/store.ts:48-89`): `period`, `range`
  (`start_ms`/`end_ms` + `_utc` ISO strings), `totals`, and `byModel[]`.
  `totals`/`byModel` entries carry `request_count`, `input_tokens`,
  `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, `total_tokens` (and `model` per entry).

Periods are UTC-aware: day = calendar day; week = Mon–Sun (ISO);
month = 1st–last (`store.ts:292-339`).

## `/token-usage/events` — paginated event log

Loopback-only. **Despite the name, this is a paginated JSON endpoint, not
an SSE stream** (`src/routes/token-usage/route.ts:31-40`).

- **Query:** `period` (as above); `page` (1-indexed, default `1`);
  `page_size` (default `20`, clamped to `[1, 100]`).
- **Response** — `TokenUsageEventsPage` (`store.ts:61-104`): `items[]`,
  `page`, `page_size`, `total`, `total_pages`, `period`, `range`. Each
  `TokenUsageEventRecord` has `id`, `created_at_ms`/`_utc`, `trace_id`,
  `session_id`, `user_id`, `source` (`copilot`|`provider`), `endpoint`
  (`chat_completions`|`embeddings`|`messages`|`provider_messages`|
  `responses`), `provider_name`, `model`, and the token counts.

### Data model behind it

Recording is an **in-process** event bus, not a wire concern: callers
emit `token_usage.recorded` with a `PersistedTokenUsageEvent`, a
subscriber enqueues a SQLite write to `token_usage_events`
(`src/lib/token-usage/index.ts:65-136`, `store.ts:130-174`). Normalizers
coerce missing/non-finite counts to `0`, unknown model → `"unknown"`,
and resolve session ID from request-context → input → fallback. (The
live SSE feed the dashboard uses is `/settings/api/events`, a different
surface — not this endpoint.)

## `/token` — raw Copilot token

Returns `{ "token": "<copilotToken>" | null }`; on failure `500`
`{ "error": "Failed to fetch token", "token": null }`
(`src/routes/token/route.ts:7-16`).

## `/_debug/state` — live diagnostics

Unauthenticated **but gated**: returns `404` unless `state.verbose` is
true (`src/routes/debug/route.ts:25-57`). The live equivalent of
`copilot-api debug`. Body bundles `git`, `runtime`
(`account_type`, `verbose`, `manual_approve`, rate-limit settings,
`models_loaded`/`models_count`, `copilot_token_present`,
`github_token_present`), `config` (summarized), `executor`, `caches`
(metrics), and `secrets` (sources only, never values).

## `/_internal/shutdown` — graceful eviction

Loopback-only **and** independently enforced in the handler: a
non-loopback caller gets `404` regardless of a valid API key — a remote
caller with credentials must not be able to evict the running instance
(`src/routes/internal/route.ts:42`).

- **Body (optional):** `{ "reason"?: string }` — logged if present;
  parse errors ignored.
- **Response:** `202` `{ "ok": true, "draining": true }`.
- **Side effect:** the process exits `0` after a 250 ms delay so the
  `202` can flush (`route.ts:65-67`).

## Acceptance

1. `GET /status` returns `service: "maximal"` with `subsystems` health,
   unauthenticated, with no upstream call.
2. `GET /usage` and `/token-usage` succeed from loopback without a key
   and `401` from a remote caller without one.
3. `GET /token-usage/events?page=2&page_size=50` returns a
   `TokenUsageEventsPage` (JSON, not SSE) with `page_size` clamped to
   `[1,100]` and correct `total_pages`.
4. `GET /_debug/state` returns `404` unless `verbose` is set; it never
   includes secret values.
5. `POST /_internal/shutdown` from loopback returns `202`
   `{ok,draining}` and the process exits shortly after; the same from a
   remote peer returns `404`.
