# PRD: Anthropic Messages Surface (Wire)

The proxy's richest surface: it accepts the **Anthropic Messages API**
and fans out to one of three different Copilot upstream wire shapes,
translating in both directions. Read
[`auth-transport-wire-prd.md`](auth-transport-wire-prd.md) first — auth,
upstream headers, and the error contract live there.

## Endpoints

| Method | Path | Handler |
|---|---|---|
| `POST` | `/v1/messages` | `src/routes/messages/handler.ts:10` |
| `POST` | `/v1/messages/count_tokens` | `src/routes/messages/count-tokens-handler.ts:65` |
| `POST` | `/:provider/v1/messages` | `src/routes/provider/messages/handler.ts:26` |
| `POST` | `/:provider/v1/messages/count_tokens` | `src/routes/provider/messages/count-tokens-handler.ts:31` |

The `:provider` form forwards to a configured passthrough provider
(e.g. real Anthropic) rather than Copilot; see *Provider-scoped* below.

## Request contract

Body is an `AnthropicMessagesPayload` (`src/lib/anthropic-types.ts:3-31`):

- **Required:** `model`, `max_tokens`, `messages[]`.
- **Optional:** `system` (string or text blocks), `tools[]`,
  `tool_choice`, `stream`, `stop_sequences`, `temperature`, `top_p`,
  `top_k`, `thinking` (`{type, budget_tokens?, display?}`),
  `output_config` (`{effort?}`), `metadata` (`{user_id?}`), `speed`.

Headers read: `x-api-key` (via auth middleware), `anthropic-beta`
(forwarded upstream and used as a warmup signal — see below),
`anthropic-version` (used only when forwarding `count_tokens` to real
Anthropic).

## Pre-dispatch pipeline

`handleCompletion()` applies these in order
(`src/routes/messages/handler.ts:50-152`) before choosing an upstream:

1. **Rate-limit check** (`handler.ts:51`) — `checkRateLimit(state)`; a
   throttled request is rejected via `forwardError`.
2. **Model-ID reversal** (`handler.ts:56`,
   `anthropic-id-rewrite.ts:51-59`) — undo the dash-date sentinel the
   `/models` list advertises: `claude-opus-4-6-20260301` →
   `claude-opus-4.6`. Non-matching IDs pass through.
3. **IDE tool sanitization** (`handler.ts:58`,
   `preprocess.ts:455-476`) — drop `mcp__ide__executeCode` when
   `defer_loading` is false; normalize the `getDiagnostics` description.
4. **Web-tools extraction** (`handler.ts:66`) — if `tools[]` contains
   Anthropic server-side tools (`web_search_20250305`,
   `web_fetch_20250910`), split them into a separate agent flow
   (`handleWithWebToolsAgent`). See `docs/spec/tool-bridge.md`.
5. **Subagent-marker detection** (`handler.ts:68`) — parse a
   `__SUBAGENT_MARKER__` prefix (carried inside a `<system-reminder>`)
   in the first user message → extract `session_id` / `agent_id` /
   `agent_type`, which drive the upstream `x-initiator: agent` and
   interaction headers.
6. **Compact detection** (`handler.ts:77`, `preprocess.ts:81-114`) —
   classify Claude Code context-compaction requests as
   `COMPACT_REQUEST` or `COMPACT_AUTO_CONTINUE`; sets a `compactType`
   flag that influences header intent and the merge step below.
7. **Small-model forcing for tool-less warmup** (`handler.ts:84-86`) —
   when `anthropic-beta` is present **and** there are no tools **and**
   `compactType == 0`, rewrite `payload.model = getSmallModel()`
   (default `gpt-5-mini`). This keeps Claude Code 2.0.28+ warmup/probe
   requests off premium quota.
8. **Tool-reference turn-boundary stripping** (`handler.ts:92`,
   `preprocess.ts:415-432`) — remove the synthetic `"Tool loaded."`
   text that accompanies `tool_reference` blocks.
9. **Mixed `tool_result` + text merge** (`handler.ts:99-101`,
   `preprocess.ts:434-452`) — when a user message mixes `tool_result`
   with text/image/document blocks, merge them so the upstream sees one
   coherent turn (avoids a fresh premium request). Skips the final
   message when `compactType == COMPACT_REQUEST`.
10. **Model endpoint lookup** (`handler.ts:110-111`) — resolve the
    (possibly variant) model ID to its canonical entry in
    `state.models`, which carries `supported_endpoints`.

## Upstream routing

The resolved model's capabilities pick the flow
(`src/routes/messages/handler.ts:122-171`):

```
web tools extracted?            ──▶ handleWithWebToolsAgent
shouldUseMessagesApi(model)?    ──▶ handleWithMessagesApi   (Copilot /v1/messages)
shouldUseResponsesApi(model)?   ──▶ handleWithResponsesApi  (Copilot /responses)
else                            ──▶ handleWithChatCompletions (Copilot /chat/completions)
```

- `shouldUseMessagesApi` requires the `useMessagesApi` config flag
  (default `true`) **and** `supported_endpoints` ∋ `/v1/messages`.
- `shouldUseResponsesApi` requires `supported_endpoints` ∋ `/responses`.
- Everything else falls back to Chat Completions.

## Upstream flow A — `handleWithMessagesApi` (preferred, Claude)

`src/routes/messages/api-flows.ts:267-346`. Native pass-through to
Copilot `${copilotBaseUrl}/v1/messages` via `createMessages()` — the
client and upstream wire shapes are both Anthropic, so there is **no body
translation**, only preprocessing:

- `prepareMessagesApiPayload()` (`preprocess.ts`) runs an explicit ordered
  list of named passes (`MESSAGES_API_PASSES`); order is load-bearing:
  1. `stripCacheControl` — drop the `scope` field and inner
     `tool_result.content[]` cache_control.
  2. `filterAssistantThinkingBlocks` — drop empty/placeholder thinking.
  3. `stripSamplingParams` — drop `temperature`/`top_p`/`top_k` for
     adaptive-thinking models (and never send `temperature`+`top_p` together).
  4. `applyAdaptiveThinking` — add `thinking: {type: "adaptive", display?}` +
     `output_config: {effort}` when the model supports it. Runs LAST: it reads
     the client's original thinking intent (`display` / `type: "disabled"`)
     before overwriting `payload.thinking` — the #210 ordering contract.
- **Non-streaming:** upstream JSON returned as-is; usage recorded via
  `normalizeAnthropicUsage()`.
- **Streaming:** upstream SSE event/data pairs are **forwarded
  unmodified** (`api-flows.ts:299-337`), accumulating usage from
  `message_start` + `message_delta`, breaking on `[DONE]`.

## Upstream flow B — `handleWithResponsesApi` (GPT family)

`src/routes/messages/api-flows.ts:152-265`. Translates Anthropic →
OpenAI **Responses** shape and back. It shares all translation/streaming
utilities with the standalone `/responses` surface
(`translateAnthropicMessagesToResponsesPayload()`,
`translateResponsesStreamEvent()`, `normalizeResponsesUsage()`); see
[`responses-wire-prd.md`](responses-wire-prd.md) for the field-level
mapping. The distinction: here the **client** speaks Anthropic and the
proxy bridges to Responses internally, whereas `/responses` is a direct
Responses-in/Responses-out proxy.

Key request mappings (`responses-translation.ts:59-100`): `system →
instructions`, `messages → input[]` (`tool_use` → `function_call`,
`tool_result` → `function_call_output`, signed `thinking` →
`reasoning`/`compaction` items, with `phase` resolution), `tools → {type:
"function", …, strict:false}`, `max_tokens → max_output_tokens` (≥12800),
`reasoning: {effort, summary:"detailed"}`, `include:
["reasoning.encrypted_content"]`. Response mapping inverts this back into
Anthropic `content[]` blocks.

## Upstream flow C — `handleWithChatCompletions` (fallback)

`src/routes/messages/api-flows.ts:77-150`. Translates Anthropic →
OpenAI **Chat Completions** and back (`non-stream-translation.ts`,
`stream-translation.ts`):

- **Request:** `system` → `{role:"system"}`, `messages` flattened with
  `tool_result` separated, `tools` → `{type:"function", function:{…}}`,
  `tool_choice` mapped (`auto`/`required`/named/`none`), `thinking` →
  `thinking_budget`.
- **Response (non-stream):** merge choices into Anthropic `content[]`;
  `tool_calls` → `tool_use` (arguments parsed defensively via
  `parseToolCallArguments` in `utils.ts` — empty/whitespace → `{}`,
  malformed JSON → `{raw_arguments}`, never a bare `JSON.parse` that
  could throw); `reasoning_text`/`reasoning_opaque` →
  `thinking`; `finish_reason` mapped (`stop→end_turn`,
  `length→max_tokens`, `tool_calls→tool_use`,
  `content_filter→end_turn`); usage de-duplicated for cached tokens.

## Streaming: emitted SSE events

All three flows emit a **canonical Anthropic event stream** to the
client (via Hono `streamSSE`), regardless of upstream shape:

| Event | When | Notable fields |
|---|---|---|
| `message_start` | once, first | `message.usage.input_tokens`, `cache_read_input_tokens?` |
| `content_block_start` | per block | `content_block.type` ∈ `text`/`tool_use`/`thinking` |
| `content_block_delta` | per chunk | `delta.type` ∈ `text_delta`/`input_json_delta`/`thinking_delta`/`signature_delta` |
| `content_block_stop` | per block end | `index` |
| `message_delta` | final | `delta.stop_reason`, `usage.output_tokens` |
| `message_stop` | stream end | — |
| `ping` | keepalive | — |
| `error` | failure | `error.{type,message}` via `emitStreamError` |

Upstream→Anthropic delta mapping: Chat Completions
`delta.content`/`reasoning_text`/`tool_calls.arguments` →
`text_delta`/`thinking_delta`/`input_json_delta`
(`stream-translation.ts:243-376`); Responses
`output_text.delta`/`reasoning_summary_text.delta`/`function_call_arguments.delta`
→ the same (`responses-stream-translation.ts`); Messages API events
forwarded verbatim.

## `count_tokens`

`src/routes/messages/count-tokens-handler.ts:65-131`:

1. Reverse the model ID (sentinel → dotted).
2. **If** the model is Claude-family **and** `anthropicApiKey` is
   configured → forward to real Anthropic `POST
   /v1/messages/count_tokens` (`x-api-key`, `anthropic-version:
   2023-06-01`, `anthropic-beta: token-counting-2024-11-01`) for an exact
   count; on any 4xx/5xx fall through to estimation.
3. **Else** estimate locally: translate to OpenAI shape, run the
   `o200k_base` tokenizer (`src/lib/tokenizer.ts`), add a tool
   system-prompt allowance (346 tokens for Claude, 120 for grok, skipped
   for `mcp__`/single-`Skill` tools), then multiply by **1.15** for
   Claude (`getClaudeTokenMultiplier()`).

The provider-scoped variant
(`provider/messages/count-tokens-handler.ts`) always uses the local
tokenizer (no real-Anthropic path, no multiplier).

## Provider-scoped (`/:provider/v1/messages`)

Forwards to a configured passthrough provider's Anthropic-compatible
endpoint rather than Copilot (`src/routes/provider/messages/handler.ts`,
`src/services/providers/anthropic-proxy.ts`). Auth is the provider's own
(`Bearer` or `x-api-key` per `authType`); forwardable client headers
(`anthropic-version`, `anthropic-beta`, `accept`, `user-agent`) are
passed through, hop-by-hop headers stripped. Usage may be adjusted via
`adjustInputTokens()` (subtract cache tokens) when the provider config
sets it.

## Error mapping

Inherits the shared upstream contract from
[`auth-transport-wire-prd.md`](auth-transport-wire-prd.md): auth-fatal
(401 / entitlement-403) clears the token and returns `auth_fatal`; other
non-OK becomes `{error:{type:"error"}}` at the upstream status (429
relayed with `retry-after`). Mid-stream failures are surfaced as an
Anthropic `error` SSE event via `emitStreamError` rather than an HTTP
status, since headers are already sent.

## Acceptance

1. `POST /v1/messages` for a Claude model with `useMessagesApi=true`
   hits Copilot `/v1/messages` and streams a verbatim Anthropic event
   sequence.
2. The same for a GPT model routes to `/responses`; for an
   otherwise-unsupported model, to `/chat/completions` — both emitting
   the **same** canonical Anthropic event stream to the client.
3. A tool-less request carrying `anthropic-beta` and no compaction is
   served by `gpt-5-mini`, not the requested premium model.
4. `count_tokens` for a Claude model returns the exact Anthropic count
   when `anthropicApiKey` is set, and a `≈1.15×` GPT-tokenizer estimate
   otherwise.
5. A mid-stream upstream failure yields an Anthropic `error` event, not a
   broken connection.
