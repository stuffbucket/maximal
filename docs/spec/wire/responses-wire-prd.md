# PRD: OpenAI Responses Surface (Wire)

A direct OpenAI **Responses API** proxy in front of Copilot `/responses`.
Read [`auth-transport-wire-prd.md`](auth-transport-wire-prd.md) first for
auth, upstream headers, and the error contract.

> The same translation/streaming utilities are reused **internally** by
> the Anthropic Messages surface's flow B (`handleWithResponsesApi`). The
> difference: here both client and upstream speak Responses (a relay with
> ID/tool surgery); there the client speaks Anthropic and the proxy
> bridges. See [`messages-wire-prd.md`](messages-wire-prd.md).

## Endpoints

| Method | Path | Handler |
|---|---|---|
| `POST` | `/responses` | `src/routes/responses/handler.ts:54` |
| `POST` | `/v1/responses` | alias (`server.ts:217`) |

Both gated by `requireGithubAuth`.

## Request contract

Body is a `ResponsesPayload`
(`src/services/copilot/create-responses.ts:22-43`):

- `model`, `input` (string or `ResponseInputItem[]`), `instructions`,
  `tools[]`, `tool_choice`, `temperature`, `top_p`, `max_output_tokens`,
  `stream`, `metadata`, `prompt_cache_key`, `prompt_cache_retention`,
  `parallel_tool_calls`, `store`, `reasoning` (`{effort, summary}`),
  `context_management`, `include` (e.g.
  `["reasoning.encrypted_content"]`), `safety_identifier`.

## Pre-dispatch handling

`src/routes/responses/handler.ts:58-105`:

1. **Model-ID reversal** — `reverseId(payload.model)` to the upstream
   dotted form.
2. **Endpoint support check** — require `supported_endpoints ∋
   "/responses"`; otherwise `400` `invalid_request_error`
   (`handler.ts:90-99`).
3. **Tool filtering** (`handler.ts:186-243`):
   - Remove unsupported types (e.g. `image_generation`).
   - Remove `web_search` when not enabled.
   - Convert a `custom` apply-patch tool to `function` type for Copilot.
4. **Context management** — auto-apply a compaction threshold (90 % of
   `max_prompt_tokens`) when the model supports it
   (`applyResponsesApiContextManagement()`); slice input history to the
   latest compaction (`compactInputByLatestCompaction()`).

## Upstream call

`POST ${copilotBaseUrl(state)}/responses`
(`create-responses.ts:407`). Payload forwarded after one mutation:
`service_tier` is stripped (Copilot rejects it,
`create-responses.ts:403`).

Headers, on top of the base Copilot set: `x-initiator: agent|user`,
plus `x-interaction-id`/`x-interaction-type`/`openai-intent` via
`prepareInteractionHeaders()` + `prepareForCompact()`
(`create-responses.ts:393-400`).

## Streaming

The Responses event stream is **forwarded** to the client, with one
critical fix-up (`src/routes/responses/handler.ts:122-154`):

| Upstream event | Client treatment |
|---|---|
| `response.created` | forwarded; usage noted |
| `response.output_item.added` | forwarded; **stream ID rewritten** |
| `response.output_text.delta` / `.done` | forwarded as-is |
| `response.function_call_arguments.delta` / `.done` | forwarded as-is |
| `response.reasoning_summary_text.delta` / `.done` | forwarded as-is |
| `response.output_item.done` | forwarded; **stream ID rewritten** |
| `response.completed` / `.incomplete` | forwarded; usage extracted |
| `response.failed` / `error` | forwarded as-is |

**Stream-ID synchronization** (`src/routes/responses/stream-id-sync.ts`):
Copilot returns *different* item IDs in `output_item.added` vs
`output_item.done`, which breaks `@ai-sdk/openai`. A per-stream tracker
maps `output_index` → a stable ID (the `added` id, or a generated
`oi_<index>_<suffix>`), then rewrites the `done` and downstream events to
match. This is the only transformation applied to the stream body.

**Non-streaming** (`handler.ts:156-161`): the upstream `response` object
(`{id, object:"response", created_at, model, output[], output_text,
status, usage, error, incomplete_details, …}`) is returned verbatim.

Usage is normalized via `normalizeResponsesUsage()` and recorded under
endpoint `responses`.

## Error mapping

Inherits the shared upstream contract (auth-fatal vs HTTP error vs
generic) from
[`auth-transport-wire-prd.md`](auth-transport-wire-prd.md). The only
proxy-originated client error is the `400` `invalid_request_error` when
the model does not support `/responses`. Upstream rate-limit headers are
parsed and logged, not surfaced (except a relayed `429`).

## Acceptance

1. `POST /v1/responses` with `stream:true` for a Responses-capable model
   forwards every Responses event, with `output_item` IDs made
   consistent between `added` and `done`.
2. A model lacking `/responses` support returns the `400`
   `invalid_request_error` without an upstream call.
3. `service_tier` in the request never reaches Copilot.
4. A `custom` apply-patch tool is sent upstream as a `function` tool;
   `image_generation` tools are dropped.
