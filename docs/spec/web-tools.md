# Web tools — Anthropic surface, Copilot surface, mapping

Status: Draft, 2026-05-01.
Owner: bstucker.
Scope: Specifies how the proxy should expose `web_search` and `web_fetch`
behavior to Anthropic-API clients (e.g. Claude Code, Claude Desktop in
Cowork gateway mode) when the underlying provider is GitHub Copilot,
which has no equivalent server-side tool.

## TL;DR

- Anthropic Messages API has two GA server-side tools: `web_search` and
  `web_fetch`. Wire shape is documented; the host (Anthropic's own API)
  resolves them on the model's behalf and injects results.
- GitHub Copilot has **no equivalent** server-resolved tools. Copilot
  CLI's built-in `web_fetch` is only callable from inside its agent
  loop; there is no out-of-band RPC.
- For our proxy to make Anthropic web tools work against a Copilot
  backend, the **proxy itself** must intercept `server_tool_use` blocks
  for these tools, execute them locally, and inject
  `web_*_tool_result` blocks back into the stream.
- This adds ~200–300 lines to caozhiyuan's translation pipeline. It
  means the proxy becomes partially agentic (executes side effects on
  the model's behalf). Acceptable scope for our P1, not P0.

## Background and the load-bearing finding

The Anthropic Messages API runs `web_search` and `web_fetch` *server
side*. The model emits a `server_tool_use` block, the API resolves it
(searches/fetches), injects a `web_search_tool_result` /
`web_fetch_tool_result` block into the assistant turn, and the model
continues generating with the result already in context. The client
sees the result blocks but never executes them.

Copilot's API does not have any analogous server-side tool. Copilot's
`/v1/messages` endpoint passes through the model's output as-is; if the
model emits `server_tool_use` for `web_search`, Copilot returns it
unresolved. Claude Desktop / Claude Code see an unresolved tool block
and surface it as broken.

Copilot CLI ships its own `web_fetch` tool, but research (subagent
report 2026-05-01) confirms it is only invokable through Copilot CLI's
agent loop:

- Interactive REPL — drives the LLM, can't be controlled
- `copilot -p "<prompt>"` — runs the agent loop once and exits
- `--acp --stdio` — exposes the *agent* (Agent Client Protocol),
  not individual tools
- The legacy `--headless --stdio` direct interface was removed without
  deprecation (`github/copilot-cli` issue #1606)

Conclusion: the proxy cannot delegate to Copilot for these tools. It
must execute them itself or give up.

## Surface 1 — Anthropic Messages API web tools

Header: `anthropic-version: 2023-06-01`. No `anthropic-beta` required;
both are GA as of April 2026. Versioned tool type names below.

### web_search

**Tool declaration** in request `tools[]`:

```json
{
  "type": "web_search_20250305",
  "name": "web_search",
  "max_uses": 5,
  "allowed_domains": ["example.com"],
  "blocked_domains": ["bad.com"],
  "user_location": {
    "type": "approximate",
    "city": "San Francisco",
    "region": "California",
    "country": "US",
    "timezone": "America/Los_Angeles"
  }
}
```

A newer version `web_search_20260209` adds dynamic filtering and
requires the code execution tool to also be declared. Out of scope for
v1; we target `web_search_20250305`.

**Model emits** (note: `server_tool_use`, not `tool_use`):

```json
{
  "type": "server_tool_use",
  "id": "srvtoolu_01WYG3...",
  "name": "web_search",
  "input": { "query": "claude shannon birth date" }
}
```

**Host injects** in the same assistant turn:

```json
{
  "type": "web_search_tool_result",
  "tool_use_id": "srvtoolu_01WYG3...",
  "content": [
    {
      "type": "web_search_result",
      "url": "https://en.wikipedia.org/wiki/Claude_Shannon",
      "title": "Claude Shannon - Wikipedia",
      "encrypted_content": "EqgfCioIA...",
      "page_age": "April 30, 2025"
    }
  ]
}
```

`encrypted_content` is opaque to the model and the client; in
multi-turn conversations it MUST round-trip unchanged.

**Errors** keep HTTP 200; body is:

```json
{
  "type": "web_search_tool_result_error",
  "tool_use_id": "srvtoolu_...",
  "content": { "type": "web_search_tool_result_error", "error_code": "..." }
}
```

Error codes: `too_many_requests`, `invalid_input`, `max_uses_exceeded`,
`query_too_long`, `unavailable`.

**Usage accounting:** `usage.server_tool_use.web_search_requests`
counts each search, not each result.

**Pause behavior:** `stop_reason: "pause_turn"` may appear; the client
must re-submit the assistant turn unchanged to continue.

**SSE event sequence (when web_search fires):**

```
message_start
content_block_start (index 0, text)
... text deltas ...
content_block_stop (index 0)
content_block_start (index 1, server_tool_use, name=web_search, partial input)
content_block_delta (input_json_delta with the query)
content_block_stop (index 1)
content_block_start (index 2, web_search_tool_result, content already populated — no deltas)
content_block_stop (index 2)
content_block_start (index 3, text — model continues with results in context)
... more text deltas ...
content_block_stop (index 3)
message_delta (stop_reason)
message_stop
```

The result block has no streaming deltas; it is emitted whole.

### web_fetch

**Tool declaration:**

```json
{
  "type": "web_fetch_20250910",
  "name": "web_fetch",
  "max_uses": 10,
  "allowed_domains": ["docs.example.com"],
  "blocked_domains": ["internal.example.com"],
  "citations": { "enabled": true },
  "max_content_tokens": 100000
}
```

A newer `web_fetch_20260209` adds dynamic filtering. Out of scope for
v1.

**Model emits:**

```json
{
  "type": "server_tool_use",
  "id": "srvtoolu_01...",
  "name": "web_fetch",
  "input": { "url": "https://example.com/article" }
}
```

The model can only fetch URLs that already appear in conversation
context (it cannot synthesize URLs).

**Host injects:**

```json
{
  "type": "web_fetch_tool_result",
  "tool_use_id": "srvtoolu_01...",
  "content": {
    "type": "web_fetch_result",
    "url": "https://example.com/article",
    "content": {
      "type": "document",
      "source": {
        "type": "text",
        "media_type": "text/plain",
        "data": "..."
      },
      "title": "Article Title",
      "citations": { "enabled": true }
    },
    "retrieved_at": "2025-08-25T10:30:00Z"
  }
}
```

PDFs use `source.type: "base64"`, `media_type: "application/pdf"`.

**Error codes:** `invalid_input`, `url_too_long`, `url_not_allowed`,
`url_not_accessible`, `too_many_requests`, `unsupported_content_type`,
`max_uses_exceeded`, `unavailable`.

**SSE sequence:** identical to web_search — `server_tool_use` with
input deltas, then `web_fetch_tool_result` emitted whole.

## Surface 2 — GitHub Copilot

### Copilot's `/v1/messages` (proxied via copilot-api)

Passes the request through unchanged, returns the model's output
unchanged. If the model emits `server_tool_use` for `web_search` /
`web_fetch`, Copilot does NOT resolve them — the unresolved
`server_tool_use` reaches the client.

This is the primary integration gap.

### Copilot CLI built-in `web_fetch`

Added in the 2026-01-14 changelog. Documented behavior:

- Retrieves URL content as markdown
- Subject to `allowed_urls` / `denied_urls` patterns in `~/.copilot/config`
- Same patterns govern shell-based network commands (`curl`, `wget`)
- `--allow-tool` flag accepts `url(github.com)`, `shell`, `write`,
  `read`, `memory`, `MCP-SERVER`

No public JSON schema for the input or output is documented. Output is
markdown text.

**Not callable as RPC.** The only invocations are:
- Interactive REPL
- `copilot -p "<prompt>"` (one-shot, full agent loop)
- `--acp --stdio` (Agent Client Protocol — drives the *agent*, not
  individual tools)

`--headless --stdio` was removed (issue #1606). The bundled `fetch`
MCP server is started internally by Copilot CLI but is not documented
as a separately spawnable binary; it is almost certainly a vendored
copy of the standard `mcp-server-fetch` reference server.

### Copilot CLI `--mcp-config`

Copilot CLI accepts external MCP servers via `--mcp-config <path>`,
pointing at a `mcp.json`. This is a *consumer* surface (Copilot CLI
calling out to MCP servers), not a producer surface. Not useful for
the proxy's needs.

## Mapping

The proxy's interceptor must translate between Anthropic's web tool
surface and a local executor (option: in-process HTTP fetch, or spawned
`mcp-server-fetch`, or external MCP/search service).

### Anthropic `web_fetch` → local executor

| Anthropic field | Local executor (e.g., MCP `fetch`) | Notes |
|---|---|---|
| `input.url` | `arguments.url` | 1:1 |
| `tools[].max_content_tokens` | `arguments.max_length` (chars) | Approximate; tokens ≠ chars |
| `tools[].citations.enabled` | n/a | MCP fetch doesn't return citation offsets; emit `citations: {enabled: false}` |
| `tools[].allowed_domains` / `blocked_domains` | enforced inside proxy before delegating | MCP fetch doesn't filter |
| `tools[].max_uses` | counter inside proxy state | proxy enforces |
| `id` (server_tool_use) | n/a | proxy synthesizes for the result's `tool_use_id` |
| executor result text | `web_fetch_result.content.content.source.data` | wrap with `media_type: text/markdown` |
| executor PDF bytes | `source.type: base64`, `media_type: application/pdf` | only if executor returns PDF mode |
| (synthesized) | `retrieved_at` (ISO8601 now) | proxy adds |

**Error code mapping:**

| Local failure | Anthropic error_code |
|---|---|
| HTTP non-2xx, DNS, timeout | `url_not_accessible` |
| Domain blocklist hit | `url_not_allowed` |
| URL > 250 chars | `url_too_long` |
| URL parse fail / missing | `invalid_input` |
| Content-type not text/html/markdown/pdf | `unsupported_content_type` |
| max_uses exceeded | `max_uses_exceeded` |
| Local rate limit | `too_many_requests` |
| Anything else | `unavailable` |

### Anthropic `web_search` → local executor

No Copilot-bundled equivalent. Options:
- Brave Search API (`mcp-server-brave-search` or direct)
- Tavily, SerpAPI, Bing — direct
- DuckDuckGo MCP (no key, lower quality)

Mapping:

| Anthropic field | Local executor | Notes |
|---|---|---|
| `input.query` | `arguments.query` | 1:1 |
| `tools[].max_uses` | counter inside proxy state | |
| `tools[].allowed_domains` / `blocked_domains` | filter results post-fetch | |
| `tools[].user_location` | most search APIs accept location hints | provider-specific |
| executor results | `web_search_tool_result.content[]` | array of `web_search_result` |
| (synthesized) | `encrypted_content` | proxy generates an opaque blob (signed JSON of provenance) — must round-trip |
| (synthesized) | `page_age` | use HTTP `Last-Modified` or omit |

**`encrypted_content` design choice:** the model never inspects this;
it only round-trips it. The proxy can use any opaque format (e.g.,
`base64(json({url, fetched_at, provenance}))`). It only needs to be
stable across re-submits in multi-turn.

## Implementation outline

The interceptor lives between caozhiyuan's existing
`routes/messages/stream-translation.ts` and the streaming response to
the client. Pseudocode:

```ts
async function* interceptWebTools(
  upstream: AsyncIterable<SSEEvent>,
  context: { tools: ToolDefs, state: WebToolState },
): AsyncIterable<SSEEvent> {
  const requested = pickWebTools(context.tools)
  if (!requested.web_search && !requested.web_fetch) {
    yield* upstream
    return
  }

  for await (const event of upstream) {
    yield event

    if (event.type === "content_block_stop"
        && current.kind === "server_tool_use"
        && (current.name === "web_search" || current.name === "web_fetch")) {

      const input = JSON.parse(current.partial_json)

      // enforce limits + filters
      const guard = checkPolicy(current.name, input, context.state, requested)
      if (guard.error) {
        yield emitErrorBlock(current, guard.error)
        continue
      }

      // execute
      const result = await executeLocal(current.name, input)

      // emit result block (no deltas — the spec emits whole)
      yield* emitResultBlock(current, result)

      context.state.uses[current.name]++
    }
  }
}
```

Pluggable executors:

```ts
interface Executor {
  fetch(url: string, opts: FetchOpts): Promise<FetchResult | FetchError>
  search(query: string, opts: SearchOpts): Promise<SearchResult[] | SearchError>
}
```

Implementations to ship:
- `InProcessExecutor` — `fetch()` + `html-to-markdown` (e.g.,
  `turndown`); `search()` requires a configured backend
- `McpExecutor` — spawn a stdio MCP server, JSON-RPC the calls
  (lazy-launched on first need)

`InProcessExecutor` runs Turndown synchronously on the event loop. To
keep one pathological page from stalling concurrent requests, the raw
HTML body is capped at `MAX_HTML_INPUT_CHARS` (2 MB) before conversion;
the resulting Markdown is independently capped by `maxChars` (default
400 KB). Non-HTML responses bypass Turndown and are returned verbatim
within the same output cap.

Default: `InProcessExecutor` for `web_fetch` (no extra deps), unset for
`web_search` (must configure or 503 with `unavailable`).

## Open decisions

1. **Executor default for `web_fetch`.** Plain HTTPS + html-to-markdown
   in-process, or always go through `mcp-server-fetch`? The in-process
   path is fewer moving parts; the MCP path matches the rest of the
   ecosystem and lets users swap implementations.
2. **`web_search` backend.** Brave (key required), DuckDuckGo
   (community), or just declare unsupported and return
   `unavailable`?
3. **Should the proxy strip `web_search`/`web_fetch` from the request
   `tools[]` if no executor is configured?** Pro: model won't try to
   call them. Con: client expectations break. Recommendation: pass
   through and return `unavailable` errors.
4. **Multi-turn `encrypted_content` stability.** Need a deterministic
   blob format that survives re-submission. Suggest signed JSON with
   HMAC of a per-proxy secret.
5. **PDF support.** v1 can return `unsupported_content_type` for PDFs.
   v2 base64-passes.
6. **Citations.** v1 emits `citations: {enabled: false}` always.
   Implementing real char-offset citations requires keeping the
   markdown anchored to the fetched bytes — meaningful work.
7. **Where in the codebase.** New file
   `src/routes/messages/web-tools-interceptor.ts`
   imported by `stream-translation.ts`. State (use counters) lives in
   the existing per-request context.

## Out of scope (v1)

- `web_search_20260209` / `web_fetch_20260209` (dynamic filtering +
  code execution dependency)
- Real citation offsets
- Cache layer (refetch every request)
- Per-org policy / audit logging (later, for team rollout)
- Routing the same executor to an MCP HTTP route on the proxy (so
  external Anthropic clients in Cowork mode can also call the same
  `fetch` tool via MCP) — this is the "proxy as MCP server" follow-up
  described in CLAUDE.md / earlier conversation. Worth doing in v2.

## References

- Anthropic web search docs:
  https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- Anthropic web fetch docs:
  https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool
- Copilot CLI 2026-01-14 changelog (web_fetch added):
  https://github.blog/changelog/2026-01-14-github-copilot-cli-enhanced-agents-context-management-and-new-ways-to-install/
- Copilot CLI MCP config:
  https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
- Copilot CLI programmatic reference:
  https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference
- Copilot CLI issue #1606 — `--headless --stdio` removed:
  https://github.com/github/copilot-cli/issues/1606
- MCP fetch reference server:
  https://github.com/modelcontextprotocol/servers/tree/main/src/fetch
- caozhiyuan/copilot-api streaming translation:
  `src/routes/messages/stream-translation.ts`
