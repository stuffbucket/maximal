# PRD: OpenAI Chat Completions Surface (Wire)

A near-transparent OpenAI Chat Completions proxy in front of Copilot
`/chat/completions`. Read
[`auth-transport-wire-prd.md`](auth-transport-wire-prd.md) first for
auth, upstream headers, and the error contract.

## Endpoints

| Method | Path | Handler |
|---|---|---|
| `POST` | `/chat/completions` | `src/routes/chat-completions/handler.ts:25` |
| `POST` | `/v1/chat/completions` | alias to the same handler (`server.ts:214`) |

Both gated by `requireGithubAuth` (`server.ts:194-202`).

## Request contract

Body is a `ChatCompletionsPayload`
(`src/services/copilot/create-chat-completions.ts:184-209`):

- **Required:** `messages[]`, `model`.
- **Optional:** `temperature`, `top_p`, `max_tokens`, `stop`, `n`,
  `stream`, `frequency_penalty`, `presence_penalty`, `logit_bias`,
  `logprobs`, `response_format`, `seed`, `tools[]`, `tool_choice`,
  `user`, `thinking_budget`.

Client headers consumed (`src/lib/trace.ts`, `request-context.ts`):
`x-trace-id` (echoed back), `user-agent` (forwarded only for opencode;
otherwise replaced), optional `x-session-affinity` and
`x-parent-session-id` (forwarded upstream when present).

## Pre-dispatch handling

`src/routes/chat-completions/handler.ts:29-72`:

1. **Model-ID reversal** — `reverseId(payload.model)`:
   `claude-opus-4-6-20260301` → `claude-opus-4.6`; non-Anthropic IDs
   (e.g. `gpt-*`) pass through (`anthropic-id-rewrite.ts:51-59`).
2. **Model validation** — look up the model in `state.models`. Special
   case: `gpt-5.4` returns `400` `invalid_request_error` with the
   message *"Please use '/v1/responses' or '/v1/messages' API"*
   (`handler.ts:33-47`).
3. **`max_tokens` auto-fill** — if null/undefined, set to the model's
   `capabilities.limits.max_output_tokens` (`handler.ts:51-57`).
4. **Request/session IDs** — `generateRequestIdFromPayload(payload)` →
   `x-request-id`/`x-agent-task-id`; a derived UUID session ID tags the
   token-usage record (`handler.ts:60-69`).

## Upstream call

`POST ${copilotBaseUrl(state)}/chat/completions`
(`create-chat-completions.ts:66`). The payload is forwarded
**as-is** via `JSON.stringify(payload)` — no field filtering or
remapping (`create-chat-completions.ts:69`).

Headers, on top of the base Copilot set (see auth PRD):

- **`Copilot-Vision-Request: true`** — added when any message contains an
  `image_url` content part (`create-chat-completions.ts:33-37`). Image
  URLs are forwarded unchanged.
- **`x-initiator: agent|user`** — `agent` when the **last** message role
  is `assistant` or `tool`, else `user`
  (`create-chat-completions.ts:39-54`).
- **`x-interaction-type`** — `conversation-subagent` for a marked
  subagent, `conversation-other` under compaction; optional
  `x-interaction-id: <sessionId>` (`api-config.ts:100-129`).

`tools[]` and `tool_choice` are forwarded with **no schema validation or
normalization** (`create-chat-completions.ts:200-218`).

## Streaming

Decided by the response shape (`handler.ts:76-96`):

- **Non-streaming** — upstream returns a `chat.completion` object
  (`choices` present); returned verbatim via `c.json(response)`. Usage
  taken from `response.usage`.
- **Streaming** (`payload.stream === true`) — upstream SSE is wrapped by
  `events()` (`fetch-event-stream`) and each
  `chat.completion.chunk` is written back to the client **exactly as
  received** (`stream.writeSSE(chunk)`, `handler.ts:82-92`). This is a
  pure pass-through; the proxy parses chunks **only** to accumulate
  `usage` for its own token accounting (`handler.ts:103-116`), not to
  re-encode. Terminates on `data: [DONE]`.

Usage is normalized by `normalizeOpenAIUsage()`
(`token-usage/index.ts:167-190`) — cached tokens are subtracted from
input to avoid double-counting — and recorded under endpoint
`chat_completions`.

## Error mapping

Inherits the shared upstream error contract from
[`auth-transport-wire-prd.md`](auth-transport-wire-prd.md):

- Auth-fatal (`401`, entitlement-`403`) → token cleared, `auth_fatal`
  body at the upstream status.
- Other non-OK → `{ "error": { "message", "type": "error" } }` at the
  upstream status; `429` relays `retry-after` + `x-*` headers.
- Missing Copilot token / unhandled exception → `500`
  `{ "error": { "message", "type": "error" } }`.
- The `gpt-5.4` redirect is the only **proxy-originated** `400`.

## Acceptance

1. `POST /v1/chat/completions` with `stream:true` yields a byte-for-byte
   pass-through of Copilot's `chat.completion.chunk` SSE, terminating on
   `[DONE]`.
2. A request whose last message is a `tool` result is sent upstream with
   `x-initiator: agent`.
3. A message carrying an `image_url` part adds
   `Copilot-Vision-Request: true` upstream.
4. `model: "gpt-5.4"` returns the `400` redirect to `/v1/responses` or
   `/v1/messages` without an upstream call.
5. A request with `max_tokens` omitted is sent upstream with the model's
   max-output limit filled in.
