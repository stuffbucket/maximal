# PRD: OpenAI Embeddings Surface (Wire)

The simplest upstream surface: a thin OpenAI Embeddings proxy in front of
Copilot `/embeddings`. Read
[`auth-transport-wire-prd.md`](auth-transport-wire-prd.md) first for
auth, upstream headers, and the error contract.

## Endpoints

| Method | Path | Handler |
|---|---|---|
| `POST` | `/embeddings` | `src/routes/embeddings/route.ts:12` |
| `POST` | `/v1/embeddings` | alias (`server.ts:216`) |

Both gated by `requireGithubAuth`.

## Request contract

Body is an `EmbeddingRequest`
(`src/services/copilot/create-embeddings.ts:19-21`):

- `model` (string).
- `input` (string or `string[]`).

No model-ID reversal or normalization is applied on this surface.

## Upstream call

`POST ${copilotBaseUrl(state)}/embeddings`
(`create-embeddings.ts:8`). The full `EmbeddingRequest` is serialized and
forwarded unchanged (`create-embeddings.ts:11`). Headers are the **base
Copilot set only** — no `x-initiator`, no vision, no interaction headers
(`create-embeddings.ts:10`). Requires `state.copilotToken`, else the
generic *"Copilot token not found"* error.

## Response contract

The upstream `EmbeddingResponse` is returned via `c.json()`
unchanged (`route.ts:26`):

```json
{
  "object": "list",
  "data": [{ "object": "embedding", "embedding": [/* number[] */], "index": 0 }],
  "model": "<model>",
  "usage": { "prompt_tokens": 0, "total_tokens": 0 }
}
```

Token usage is recorded under endpoint `embeddings`, mapping
`response.usage.prompt_tokens → input_tokens` and `output_tokens = 0`
(`route.ts:17-23`).

## Error mapping

Inherits the shared upstream contract from
[`auth-transport-wire-prd.md`](auth-transport-wire-prd.md): a non-200
upstream becomes `{ "error": { "message", "type" } }` at the upstream
status via `forwardError()` (`429` relays `retry-after` + `x-*`); a
missing token surfaces as a generic `500`. There is no proxy-originated
validation error on this surface.

## Acceptance

1. `POST /v1/embeddings` with `{model, input}` returns Copilot's
   embedding list verbatim and records `prompt_tokens` as `input_tokens`.
2. A `string[]` input is forwarded unchanged (one embedding per element).
3. An upstream `429` is relayed with its `retry-after` header intact.
