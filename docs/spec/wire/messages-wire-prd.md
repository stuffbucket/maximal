# PRD: Anthropic Messages Surface (Wire)

The proxy's richest surface: it accepts the **Anthropic Messages API**
and fans out to one of three different Copilot upstream wire shapes,
translating in both directions. Read
[`auth-transport-wire-prd.md`](auth-transport-wire-prd.md) first — auth,
upstream headers, and the error contract live there.

## Endpoints

| Method | Path | Handler |
|---|---|---|
| `POST` | `/v1/messages` | `handleCompletion()` in `src/routes/messages/handler.ts` |
| `POST` | `/v1/messages/count_tokens` | `handleCountTokens()` in `src/routes/messages/count-tokens-handler.ts` |
| `POST` | `/:provider/v1/messages` | `handleProviderMessages()` in `src/routes/provider/messages/handler.ts` |
| `POST` | `/:provider/v1/messages/count_tokens` | `handleProviderCountTokens()` in `src/routes/provider/messages/count-tokens-handler.ts` |

The `:provider` form forwards to a configured passthrough provider
(e.g. real Anthropic) rather than Copilot; see *Provider-scoped* below.

## Request contract

Body is an `AnthropicMessagesPayload` (`src/lib/models/anthropic-types.ts`):

- **Required:** `model`, `max_tokens`, `messages[]`.
- **Optional:** `system` (string or text blocks), `tools[]`,
  `tool_choice`, `stream`, `stop_sequences`, `temperature`, `top_p`,
  `top_k`, `thinking` (`{type, budget_tokens?, display?}`),
  `output_config` (`{effort?}`), `context_management`, `service_tier`,
  `metadata` (`{user_id?}`), `speed`.

Headers read:

- `x-api-key` (via auth middleware).
- `anthropic-beta` — forwarded upstream, used as a warmup signal, and
  `context-1m-2025-08-07` selects a long-context model variant.
- `anthropic-version` — used only when forwarding `count_tokens` to real
  Anthropic.
- Optional Claude Code hint headers: `x-claude-code-request-class` and
  `x-claude-code-agent-type` (subagent detection, step 7),
  `x-claude-code-compaction` (compaction detection, step 8), and
  `x-claude-code-prompt-id` (request id, step 12).

## Pre-dispatch pipeline

`handleCompletion()` applies these in order before choosing an upstream:

1. **Rate-limit check** — `checkRateLimit(state)`; a throttled request
   is rejected through the route's `forwardAnthropicError`.
2. **Unsupported top-level field stripping** —
   `stripUnsupportedTopLevelAnthropicFields()` drops `diagnostics`.
3. **Model resolution** — `reverseId()`
   (`src/lib/models/anthropic-id-rewrite.ts`) undoes the dash-date
   sentinel the `/models` list advertises (`claude-opus-4-6-20260301` →
   `claude-opus-4.6`; non-matching IDs pass through); configured
   `modelMappings` are applied (`resolveModelMapping()`; a mapping to an
   unavailable model returns `400`); then `pickCopilotVariantId()` picks
   the most specific Copilot variant for `output_config.effort` and the
   `context-1m-2025-08-07` beta.
4. **IDE tool sanitization** (`sanitizeIdeTools()`) — drop
   `mcp__ide__executeCode` when `defer_loading` is false; normalize the
   `getDiagnostics` description.
5. **Claude Code provider-tool compatibility**
   (`stripUnsupportedClaudeCodeTools()`) — for a Claude agent user agent
   (`claude-cli/*` or `claude-code/*`, case-insensitive — Claude Code,
   Claude Desktop, and Cowork; `classifyClaudeClient()`), omit only the exact `advisor_20260301` /
   `advisor` declaration that Copilot cannot execute. Other clients and
   all other provider-tool declarations retain their requested semantics.
6. **Web-tools extraction** (`splitWebTools()`) — if `tools[]` contains
   Anthropic server-side tools (`web_search_20250305`,
   `web_fetch_20250910`), split them into a separate agent flow while
   preserving unrelated declarations unchanged
   (`handleWithWebToolsAgent`). Implementation:
   `src/routes/messages/web-tools/`.
7. **Subagent detection** (`parseSubagentMarkerFromFirstUser()`,
   `src/routes/messages/subagent-marker.ts`) — first, parse a
   `__SUBAGENT_MARKER__` prefix (carried inside a `<system-reminder>`) in
   the first user message → `session_id` / `agent_id` / `agent_type`.
   With no marker, fall back to the hint headers: an
   `x-claude-code-request-class` of `subagent`, `agent`, `background`,
   `background_agent`, `speculative`, or `side_question` — or an
   `x-claude-code-agent-type` with no request class — counts as a
   subagent; `interactive` never does. A detected subagent drives the
   upstream `x-initiator: agent` and `x-interaction-type:
   conversation-subagent` headers.
8. **Compact detection** (`getCompactType()`, `preprocess.ts`) — classify
   Claude Code context-compaction requests as `COMPACT_REQUEST` or
   `COMPACT_AUTO_CONTINUE`. An auto-continue last message wins; otherwise
   an `x-claude-code-compaction` header of `manual`, `auto`, `reactive`,
   `snip`, or `background` marks a `COMPACT_REQUEST`; otherwise the last
   message and system prompt are matched against known compaction
   prompts. `compactType` influences header intent and the merge step
   below.
9. **Tool-less warmup short-circuit** (`src/routes/messages/warmup.ts`) —
   when `anthropic-beta` is present, there are no tools, and
   `compactType == 0`, `isWarmupRequest()` checks for exactly one user
   message whose text trims to `Warmup`. A match is answered by
   `respondToWarmup()` with a canned local `"OK"` reply (buffered or
   streamed) and **no upstream call**. Other tool-less beta requests
   continue to the selected upstream model unchanged.
10. **Tool-reference turn-boundary stripping**
    (`stripToolReferenceTurnBoundary()`) — remove the synthetic
    `"Tool loaded."` text that accompanies `tool_reference` blocks.
11. **Mixed `tool_result` + text merge** (`mergeToolResultForClaude()`) —
    when a user message mixes `tool_result` with text/image/document
    blocks, merge them so the upstream sees one coherent turn (avoids a
    fresh premium request). Skips the final message when
    `compactType == COMPACT_REQUEST`.
12. **Request id** — a valid non-nil UUID in `x-claude-code-prompt-id` is
    used as the upstream request id; otherwise one is derived from the
    payload and session.
13. **Manual approval** — when `state.manualApprove` is set, wait for
    approval.
14. **Model endpoint lookup** (`findEndpointModel()`) — resolve the
    (possibly variant) model ID to its canonical entry in
    `state.models`, which carries `supported_endpoints`.

## Upstream routing

The resolved model's capabilities pick the flow (end of
`handleCompletion()`):

```
web tools extracted?            ──▶ handleWithWebToolsAgent
shouldUseMessagesApi(model)?    ──▶ handleWithMessagesApi   (Copilot /v1/messages)
shouldUseResponsesApi(model)?   ──▶ handleWithResponsesApi  (Copilot /responses)
else                            ──▶ handleWithChatCompletions (Copilot /chat/completions)
```

- A web-tools request uses `/responses` for each agent turn when the
  selected model advertises that endpoint; otherwise the agent retains its
  Chat Completions fallback. This applies to both buffered and streaming
  turns, which are normalized to the same Anthropic response/event shapes.
- `shouldUseMessagesApi` requires the `useMessagesApi` config flag
  (default `true`) **and** `supported_endpoints` ∋ `/v1/messages`.
- `shouldUseResponsesApi` requires `supported_endpoints` ∋ `/responses`.
- Everything else falls back to Chat Completions.

## Upstream flow A — `handleWithMessagesApi` (preferred, Claude)

`handleWithMessagesApi()` in `src/routes/messages/api-flows.ts`. Native pass-through to
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
  unmodified**, accumulating usage from
  `message_start` + `message_delta`, breaking on `[DONE]`.

## Upstream flow B — `handleWithResponsesApi` (GPT family)

`handleWithResponsesApi()` in `src/routes/messages/api-flows.ts`.
Translates Anthropic → OpenAI **Responses** shape and back
(`translateAnthropicMessagesToResponsesPayload()` and
`translateResponsesResultToAnthropic()` in `responses-translation.ts`;
streaming in `responses-stream-translation.ts`). The distinction: here the **client** speaks Anthropic and the
proxy bridges to Responses internally, whereas `/responses` is a direct
Responses-in/Responses-out proxy.

Key request mappings (`translateAnthropicMessagesToResponsesPayload()`): `system →
instructions`, `messages → input[]` (`tool_use` → `function_call`,
`tool_result` → `function_call_output`, signed `thinking` →
`reasoning`/`compaction` items, with `phase` resolution), `tools → {type:
"function", …, strict:false}`, `max_tokens → max_output_tokens` (≥12800),
`reasoning: {effort, summary:"detailed"}`, `include:
["reasoning.encrypted_content"]`. Response mapping inverts this back into
Anthropic `content[]` blocks.

## Upstream flow C — `handleWithChatCompletions` (fallback)

`handleWithChatCompletions()` in `src/routes/messages/api-flows.ts`. Translates Anthropic →
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
(`stream-translation.ts`); Responses
`output_text.delta`/`reasoning_summary_text.delta`/`function_call_arguments.delta`
→ the same (`responses-stream-translation.ts`); Messages API events
forwarded verbatim.

## `count_tokens`

`handleCountTokens()` in `src/routes/messages/count-tokens-handler.ts`:

1. Strip unsupported fields/tools and tool-reference boundaries, reverse
   the model ID (sentinel → dotted), and apply `modelMappings`.
2. **If** the model is Claude-family **and** an Anthropic key is
   configured (`anthropicApiKey`, else `ANTHROPIC_API_KEY`) → forward to real Anthropic `POST
   /v1/messages/count_tokens` (`x-api-key`, `anthropic-version:
   2023-06-01`, `anthropic-beta: token-counting-2024-11-01`) for an exact
   count; on any 4xx/5xx fall through to estimation.
3. **Else** estimate locally: translate to OpenAI shape, run the model's
   advertised tokenizer (default `o200k_base`; `src/lib/models/tokenizer.ts`),
   add a tool system-prompt allowance when `anthropic-beta` is present
   (346 tokens for Claude, 120 for grok, skipped for `mcp__`/single-`Skill`
   tools), then multiply Claude counts by `getClaudeTokenMultiplier()`
   (config `claudeTokenMultiplier`, default **1.15**). An unknown model
   or any error returns `{ "input_tokens": 1 }`.

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

Routes map errors with `forwardAnthropicError()` (see
[`auth-transport-wire-prd.md`](auth-transport-wire-prd.md)): every error
is an Anthropic `{ "type": "error", "error": { "type", "message" } }`
envelope. Auth-fatal (401 / entitlement-403) degrades the account and
keeps the upstream status; transient upstream `500`/`502`/`503`/`504`
become a retryable `529 overloaded_error`; a 4xx context overflow becomes
a `400` reworded to `prompt is too long: …` so Claude Code compacts;
other non-OK keeps its status (429 relayed with `retry-after`). Mid-stream failures are surfaced as an
Anthropic `error` SSE event via `emitStreamError` rather than an HTTP
status, since headers are already sent.

## Acceptance

1. `POST /v1/messages` for a Claude model with `useMessagesApi=true`
   hits Copilot `/v1/messages` and streams a verbatim Anthropic event
   sequence.
2. The same for a GPT model routes to `/responses`; for an
   otherwise-unsupported model, to `/chat/completions` — both emitting
   the **same** canonical Anthropic event stream to the client.
3. A web-tools request for a Responses-only model uses `/responses` for
   both buffered and streaming agent turns; models without that endpoint
   retain the Chat Completions fallback.
4. Claude Code requests omit the unsupported `advisor_20260301` / `advisor`
   declaration, while non-Claude-Code clients and unrelated server-tool
   declarations pass through unchanged.
5. A matching tool-less Claude Code warmup carrying `anthropic-beta` is
   answered locally; a non-warmup request with the same broad headers is not.
6. `count_tokens` for a Claude model returns the exact Anthropic count
   when an Anthropic key is configured, and a multiplier-scaled
   (default `1.15×`) local-tokenizer estimate otherwise.
7. A mid-stream upstream failure, including inside the web-tools agent,
   yields an Anthropic `error` event rather than a broken or empty connection.
