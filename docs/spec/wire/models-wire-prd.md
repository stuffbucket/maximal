# PRD: Models Surface (Wire)

Lists the models the proxy can serve, in OpenAI list shape (and a
provider-scoped passthrough). Read
[`auth-transport-wire-prd.md`](auth-transport-wire-prd.md) first for auth
and upstream headers.

## Endpoints

| Method | Path | Handler |
|---|---|---|
| `GET` | `/models` | `src/routes/models/route.ts:10` |
| `GET` | `/v1/models` | alias (`server.ts:215`) |
| `GET` | `/:provider/v1/models` | `src/routes/provider/models/route.ts:15` |

`/models` is gated by `requireGithubAuth`.

## Where the list comes from

The proxy does **not** fetch the model list per request. It serves a
cached list and refreshes it lazily:

- **Boot fetch** — `cacheModels()` calls `getModels()`:
  `POST ${copilotBaseUrl}/models` with model-access headers
  (`x-interaction-type: model-access`, `openai-intent: model-access`)
  (`src/services/copilot/get-models.ts:8-26`, `api-config.ts:218-231`).
- **Lazy stale-while-revalidate** — `staleRefreshMiddleware`
  (`server.ts:101-112`) runs after auth on every authenticated request.
  `refreshIfStale()` (`src/lib/refresh-models.ts:93-116`) compares
  `getModelsLoadedAtMs()` against `STALE_AFTER_MS` (6 h) ± a deterministic
  per-machine jitter of ±1 h (SHA-256 of `state.macMachineId`). When
  stale, it fires a **background** refresh (single-flight guarded by
  `refreshInFlight`) and the triggering request continues on the slightly
  stale cache; the *next* request sees fresh data.
- **Fallback** — a `GET /models` while `state.models` is null triggers a
  synchronous `cacheModels()` (`route.ts:12-14`).

## Response contract — `/models` and `/v1/models`

**Protocol-negotiated.** One catalog is served in the shape the client's
protocol expects, built by explicit mappers in
`src/routes/models/wire-models.ts` (never by spreading the raw Copilot
model — that leaked `billing`/`policy`/capability internals and could
make a strict client reject the list and render an empty picker).

Negotiation (`prefersAnthropicModels`): an `anthropic-version` request
header, or an `anthropic/…` / `claude…` user-agent → **Anthropic** shape.
Everything else — including no signal — → **OpenAI** shape (the historical
default; keeps Codex / the openai SDK / LiteLLM working).

**OpenAI shape** (default):

```json
{
  "object": "list",
  "data": [
    { "id": "claude-opus-4-6-20260301", "object": "model", "created": 0, "owned_by": "<vendor>" }
  ],
  "has_more": false
}
```

**Anthropic shape** (on signal) — mirrors Anthropic's Models API
(`{data, first_id, has_more, last_id}`; no `object`):

```json
{
  "data": [
    {
      "id": "claude-opus-4-6-20260301",
      "type": "model",
      "display_name": "<name>",
      "created_at": "1970-01-01T00:00:00.000Z",
      "max_input_tokens": 1000000,
      "max_tokens": 64000,
      "capabilities": {
        "image_input": { "supported": true },
        "pdf_input": { "supported": false },
        "structured_outputs": { "supported": true },
        "thinking": { "supported": true }
      }
    }
  ],
  "first_id": "claude-opus-4-6-20260301",
  "has_more": false,
  "last_id": "claude-opus-4-6-20260301"
}
```

Anthropic `capabilities` are derived from the Copilot model's `supports`
(`image_input`←`vision`, `thinking`←`adaptive_thinking`/`reasoning_effort`,
`structured_outputs`←`structured_outputs`); `max_input_tokens`/`max_tokens`
from `limits`. `created_at` is epoch (the Copilot catalog carries no
release date; Anthropic permits epoch).

Two transforms shape the list (both shapes):

- **ID rewrite** — `forwardId()` converts the upstream dotted ID to a
  dash-date sentinel: `claude-opus-4.6` → `claude-opus-4-6-20260301`,
  `claude-opus-4.7-high` → `claude-opus-4-7-high-20260301`
  (`anthropic-id-rewrite.ts:31-39`). This preserves the minor version in
  Claude Desktop's model picker. The inbound handlers reverse it
  (`reverseId()`).
- **Filtering** — variant IDs (suffixes `-low`/`-medium`/`-high`/
  `-xhigh`/`-max`/`-1m`/`-1m-internal`) are omitted because Anthropic
  exposes those as request-time parameters, not separate models
  (`anthropic-id-rewrite.ts:67-72`); only models with
  `model_picker_enabled: true` **or** `type: "embeddings"` are listed
  (`src/lib/utils.ts:29`).

## Response contract — `/:provider/v1/models`

Passthrough to the configured provider's `${baseUrl}/v1/models`
(`src/services/providers/anthropic-proxy.ts:79-87`). Provider auth
(`Bearer`/`x-api-key` per `authType`) and forwardable headers
(`anthropic-version`, `anthropic-beta`, `accept`, `user-agent`) are
applied; the response is relayed with hop-by-hop headers stripped
(`connection`, `content-encoding`, `content-length`, `keep-alive`,
`proxy-*`, `te`, `trailer`, `transfer-encoding`, `upgrade`). The body
shape is whatever the provider returns (Anthropic models list).

## Error mapping

- Unknown provider → `404` `{ "error": { "message", "type":
  "invalid_request_error" } }` (`provider/models/route.ts:20-30`).
- Upstream Copilot fetch failure → logged; `forwardError()` returns a
  `500` `{ "error": { "type": "error" } }`.
- Provider upstream errors → status/body relayed as-is.

A background refresh failure is **swallowed** — the stale cache keeps
serving and a warning is logged (`server.ts:106-110`). The list never
goes empty due to a transient refresh error.

## Acceptance

1. `GET /v1/models` returns the OpenAI list shape with dash-date IDs and
   no variant entries.
2. A request after the 6 h (±1 h) staleness window triggers a background
   refresh without delaying the response; the list is never blanked on a
   refresh error.
3. `GET /anthropic/v1/models` relays the configured provider's model
   list with hop-by-hop headers removed; an unknown provider → `404`.
