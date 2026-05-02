# Ollama anthropic.go — spike notes

Date: 2026-05-01.
Source: `ollama/ollama` `middleware/anthropic.go` (commit pinned in
`anthropic.go` next to this file). 955 LOC + 3006 LOC of tests.

Goal: read Ollama's reference implementation of Anthropic-server-side
`web_search` resolution and decide what to adopt, what to diverge from,
and what's still missing in our `src/routes/messages/web-tools-*.ts`.

## TL;DR

- Ollama solves the **same problem** we do (model emits a server-side
  web_search tool call → middleware must execute it and inject results
  back into the assistant turn) but with a fundamentally different
  starting position: **they own the model**, so they can train it to
  emit `server_tool_use` natively. We don't, so we strip the
  server-side decl, attach a client-side shim, and intercept regular
  `tool_use` blocks — confirmed correct call.
- The **request rewrite** half (our `web-tools-rewriter.ts`) has no
  Ollama counterpart and isn't borrowable. The **stream-injection +
  loop** half (our missing `web-tools-agent.ts`) maps almost 1:1.
- Ollama's loop is ~150 LOC of Go we can transliterate to TS with
  minor adjustments.
- Several of our existing design decisions are confirmed correct by
  Ollama doing the same: error-as-content-block (not HTTP error),
  monotonic index counter for injected blocks, max-uses guarding,
  preferring web_search when mixed with other tool calls.

## Architectural divergence (the load-bearing one)

| Concern | Ollama | Ours | Implication |
|---|---|---|---|
| Server-side tool decl in request | Pass through | **Strip + substitute client-side shim** (`web-tools-rewriter.ts`) | Required: Copilot/our models aren't trained on Anthropic's server-side surface |
| What the model emits | `server_tool_use` block named `web_search` | Regular `tool_use` block named `web_search` (our shim) | Detection differs in name space, not in shape |
| What clients see | `server_tool_use` + `web_search_tool_result` (real Anthropic shape) | Same — we synthesize both blocks ourselves, hiding the shim from clients | Equivalent client experience |
| Upstream re-invocation | Non-streaming `/api/chat` followup with synthesized assistant + tool messages | Same pattern, against Copilot `/v1/messages` (or whichever flow handler routed) | Direct port |

Our shim approach means we run the loop one indirection deeper but the
client never sees it.

## Reusable patterns from `anthropic.go`

### 1. Stream-injection state machine (lines 591–722)

The `WebSearchAnthropicWriter` carries four fields that we should
mirror in our interceptor state:

```go
streamMessageStarted bool
streamHasOpenBlock   bool
streamOpenBlockIndex int
streamNextIndex      int
```

Behavior in `writePassthroughStreamChunk` (591–620):

- Track `message_start` → flips `streamMessageStarted`.
- Track `content_block_start` → records `streamOpenBlockIndex`,
  bumps `streamNextIndex` to `index+1`.
- Track `content_block_stop` → clears `streamHasOpenBlock`.
- Track `message_stop` → marks terminal.

Then `closeOpenStreamBlock` + `writeStreamContentBlocks` (652–722) inject
synthetic blocks at fresh `streamNextIndex` *after* closing whatever was
open. For text blocks they emit start → delta → stop. For
tool_use / tool_result blocks they emit start with the full block then
stop — **no input_json_delta is generated for synthesized blocks.**
This matches our spec note in `web-tools.md` that the result block has
no streaming deltas.

**Adopt verbatim.** This is the part of D4 most likely to be subtly
wrong without a reference.

### 2. Async loop kickoff during streaming (lines 186–199, 378–406)

When streaming and a `web_search` is detected, Ollama:

1. Continues to pass through upstream chunks untouched.
2. Spawns a goroutine that runs the search and re-calls upstream.
3. Waits on a result channel only when upstream emits `Done`.

This is a latency optimization — search runs in parallel with the
remaining upstream tokens (which the model already committed to before
the tool call).

**Adopt with a TS equivalent.** Replace the goroutine + channel with a
`Promise<LoopResult>` started at detection time and awaited at the end
of the upstream stream. Behaviorally identical.

### 3. Bounded loop with synthesized followup messages (lines 225–376)

```go
const maxWebSearchLoops = 3
```

For each iteration:

- `extractQueryFromToolCall` → `anthropic.WebSearch(query)` (the
  hosted Ollama search endpoint).
- Build `serverContent` accumulator: append `server_tool_use` +
  `web_search_tool_result` blocks (lines 281–293).
- `buildWebSearchAssistantMessage` (488–500): synthesize the
  assistant message with the tool_call attached, preserving any
  preceding text/thinking content from the original model output.
- `formatWebSearchResultsForToolMessage` (502–512): render the
  results as plain text for the followup tool message — the model
  re-reads them as a normal tool result.
- `callFollowUpChat` (541–589): non-streaming POST to `/api/chat`.
- If the followup also contains `web_search`, recurse. Otherwise
  combine `serverContent` + final response content.

**Adopt the loop shape.** Differences for us:

- Followup hits `/v1/messages` (or whichever flow we routed).
- The followup synthesized message uses Anthropic's `tool_use` + user
  `tool_result` shapes, not Ollama's `assistant` + `tool` role pair.
- Our `max_uses` from the tool decl replaces the hardcoded `3`. Add a
  hard ceiling (e.g. 10) to defend against unset/huge values.

### 4. Error-as-content-block (lines 776–810)

Errors are returned as `web_search_tool_result_error` content blocks
embedded in a normal assistant message, with `stop_reason: end_turn`.
HTTP stays 200. Our `WebSearchErrorBlock` in `web-tools-types.ts` is
the right shape; confirmed.

Error codes Ollama uses: `invalid_request`, `unavailable`,
`api_error`, `max_uses_exceeded`. Ours expands to the full Anthropic
set in `web-tools-vocab.ts` — keep ours, it's more spec-faithful.

### 5. Tool-call disambiguation (lines 514–531, 171–174)

`findWebSearchToolCall` returns `(toolCall, hasWebSearch, hasOtherTools)`.
When mixed, **prefer `web_search`** and log a debug. Adopt this rule —
it's the cleanest way to handle the case where the model emits both a
web_search shim call and a regular client tool call in the same turn.

### 6. Cloud kill-switch (lines 874–883)

`internalcloud.Status()` gates web_search per env / config. Useful
pattern for an ops kill-switch on our side
(e.g. `MAXIMAL_WEB_SEARCH_DISABLED=1` → return `unavailable`). Cheap
to add when wiring the executor.

## Where Ollama and we should diverge

### A. `encrypted_content`

Ollama **omits** it entirely from `WebSearchResult` blocks. Anthropic
docs say the client must round-trip it; Claude Code apparently
tolerates missing/empty values in practice. Our `WebSearchResultItem`
type requires it.

Decision options:
- **v1:** emit empty string `""`. Matches Ollama, ships now.
- **v2:** emit signed-JSON blob (`base64(json({url, fetched_at}))` +
  HMAC) per spec section "encrypted_content design choice".

Recommend v1 now, file v2 as a follow-up. Make the field type
`encrypted_content: string` (already is) and leave the value empty.

### B. `web_fetch` — entirely uncharted in Ollama

`anthropic.go` handles only `web_search`. There is no `web_fetch`
middleware. We're on our own for fetch.

The good news: the loop shape is identical. Detect `web_fetch` shim
tool_use → run executor → emit `web_fetch_tool_result` → re-call
upstream with synthesized `tool_use` + `tool_result` messages. Same
state machine, different result block shape.

### C. Streaming the followup

Ollama's followup is **always non-streaming**, even when the original
is streaming. This is a real simplification — only the first and last
hops talk SSE; intermediate loop iterations are JSON in/out. The final
response is streamed back as injected blocks via
`writeStreamContentBlocks`.

**Adopt this.** Massively simpler than re-streaming each loop step.

### D. Loop bound

Ollama: hardcoded `maxWebSearchLoops = 3`. Ours: per-tool `max_uses`
from the declaration (defaults 5 search / 10 fetch).

Keep ours — it's spec-correct — but **add a hard ceiling** of e.g. 10
to defend against pathological max_uses values in the request. Apply
the ceiling in `checkSearchPolicy` / `checkFetchPolicy`.

## Gap in our current implementation

Files present in `src/routes/messages/`:
- ✅ `web-tools-vocab.ts` (D1)
- ✅ `web-tools-types.ts` (D3)
- ✅ `web-tools-state.ts` (D4 state + policy)
- ✅ `web-tools-rewriter.ts` (D2 — request-side strip + shim)
- ✅ `web-tools-executor.ts` (D5 — fetch impl, search stubbed)

**Missing — the agent loop.** No `web-tools-agent.ts` or interceptor
glue that:

1. Subscribes to the upstream SSE stream from `stream-translation.ts`.
2. Tracks the four index-bookkeeping fields.
3. On `content_block_stop` of a `tool_use(web_search|web_fetch)`,
   parses `partialJson`, runs `checkSearchPolicy` / `checkFetchPolicy`,
   invokes the Executor.
4. Injects synthetic `server_tool_use` + result blocks into the SSE
   stream at fresh indices (the **transformation** to the
   Anthropic-server-side wire shape happens here, not earlier).
5. Re-calls the upstream `/v1/messages` flow with synthesized
   `tool_use` + user `tool_result` messages, non-streaming, until the
   model responds without another web_search/web_fetch call.
6. Streams the final assistant content back to the client as
   block start/delta/stop events.

This is the next domain (call it D6). Estimated 200–250 LOC in TS,
heavily borrowing structure from `anthropic.go` lines 139–809.

## Recommended port skeleton

```ts
// web-tools-agent.ts (proposed)

interface StreamState {
  messageStarted: boolean
  hasOpenBlock: boolean
  openBlockIndex: number
  nextIndex: number
}

interface LoopContext {
  state: RequestState              // from web-tools-state.ts
  executor: Executor               // from web-tools-executor.ts
  reinvoke: ReinvokeUpstream       // closure that posts a non-streaming
                                   // /v1/messages with messages so far
}

async function* interceptStream(
  upstream: AsyncIterable<SSEEvent>,
  ctx: LoopContext,
): AsyncIterable<SSEEvent> {
  const stream: StreamState = { messageStarted: false, hasOpenBlock: false, openBlockIndex: 0, nextIndex: 0 }
  let interceptor: InterceptorState = IDLE
  let pendingExec: Promise<ExecResult> | null = null

  for await (const ev of upstream) {
    updateStreamState(stream, ev)

    // Intercept buffering of a web-tool tool_use
    if (ev.type === "content_block_start" && isWebToolUse(ev)) {
      interceptor = startBuffering(ev.id, ev.name)
      // SWALLOW the original tool_use start — we'll emit a server_tool_use later
      continue
    }
    if (interceptor.kind === "buffering" && ev.type === "content_block_delta") {
      interceptor = appendDelta(interceptor, ev.delta.partial_json)
      continue   // also swallowed
    }
    if (interceptor.kind === "buffering" && ev.type === "content_block_stop") {
      // Kick off async execution; don't await yet
      pendingExec = runOne(interceptor.tool, ctx)
      interceptor = IDLE
      continue
    }

    yield ev   // passthrough
  }

  // Stream finished; resolve the loop and emit synthesized blocks
  if (pendingExec) {
    const result = await pendingExec
    const finalBlocks = await runFollowupLoop(result, ctx)   // recursive non-streaming hops
    yield* emitInjectedBlocks(stream, finalBlocks)
    yield messageDelta(stopReason)
    yield messageStop()
  }
}
```

This is the skeleton; ~30% of `anthropic.go` translated. The
`runFollowupLoop` body is the direct analogue of `runWebSearchLoop`
(225–376) and is the bulk of remaining work.

## Open questions surfaced by the spike

1. **Where does `reinvoke` live?** Does it call back into our own
   handler (recursive Hono context) or directly hit the Copilot
   upstream client? Cleanest is the upstream client — same path
   `handleWithMessagesApi` uses, with `stream: false`.
2. **How do we represent the synthesized `tool_use` + user
   `tool_result` for followup?** Our shim makes this natural: we send
   the same `tool_use` shape the model already emitted, plus a normal
   `user` message containing a `tool_result` content block with the
   formatted search results / fetched markdown. Keep it inside the
   normal Anthropic protocol; no special types needed.
3. **Shared text content preservation.** Ollama's
   `buildWebSearchAssistantMessage` (488–500) preserves any text /
   thinking the model produced *before* the tool_use. We need the same
   — the upstream may have emitted text deltas before the tool_use we
   intercepted; those need to land in the synthesized assistant
   message for the followup.

## Concrete next steps

1. Write `web-tools-agent.ts` against this skeleton (D6).
2. Wire it into `stream-translation.ts` and `non-stream-translation.ts`
   between upstream response and client-facing SSE.
3. Implement the SearXNG and Ollama search executors (D5 follow-up)
   so D6 has a real backend to call.
4. Port Ollama's tests at `middleware/anthropic_test.go` (3000 LOC of
   them — many directly applicable; especially the index-management
   and mid-stream-injection cases). Pick the ~10 most load-bearing.
