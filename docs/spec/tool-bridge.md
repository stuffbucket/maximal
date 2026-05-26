# Tool bridge — generic Anthropic-server-tool → MCP mapping

Status: Draft, 2026-05-01.
Owner: bstucker.
Scope: Generalizes `web-tools.md` from a hardcoded `web_search` /
`web_fetch` interceptor into a config-driven bridge that resolves any
Anthropic *server-side* tool call by delegating to a configured MCP
server.

## TL;DR

- Config file declares: "for Anthropic server tool `X`, route to MCP
  server `Y`'s tool `Z`, transform args with mapping `M_in`, transform
  result with mapping `M_out`."
- Proxy inspects each request's `tools[]`, matches declared types to
  config entries, and intercepts the corresponding `server_tool_use`
  blocks in the response stream.
- New Anthropic server tools (or new MCP backends) are wired via
  config alone. No proxy code changes.
- `web-tools.md`'s hardcoded mappings are restated as the v1 default
  config; nothing in this spec contradicts that one — it generalizes
  the executor layer.

## Why this generalization

`web-tools.md` solves *today's* problem (web_search, web_fetch). But:

- Anthropic ships new versioned server tools every few months
  (`web_search_20260209`, `web_fetch_20260209`, future
  `code_execution_*`, etc.). Each one was going to require a code
  change.
- Org-specific tools exist on the MCP side that map cleanly to the
  same shape (e.g. an internal "fetch-jira-issue" wrapped as
  `web_fetch` for a `jira.example.com` allowlist).
- A user's preferred backend (Brave vs. Tavily vs. internal search
  appliance) shouldn't require recompiling the proxy.

Config-driven mapping makes the proxy a stable surface; the wiring is
data.

## How it composes with `tool-hub` (Extension B)

This spec is "Extension A" only. Extension B (proxy itself exposing an
MCP server route at `/mcp/...` so external clients call the same
executors) is separate. The two compose: same `Executor` instances
back both the inbound interceptor (Extension A) and the outbound MCP
route (Extension B). Extension B's spec, when written, will reference
this one's `Executor` interface verbatim.

## Concept: the bridge entry

A **bridge entry** is one config record that says:

> When the request declares an Anthropic server tool of type
> `<anthropic-type>`, intercept the model's `server_tool_use` blocks
> for it; for each call, map the input through `<input-mapping>`,
> invoke MCP tool `<mcp-tool>` on server `<mcp-server>`, then map the
> response through `<output-mapping>` and emit it as
> `<anthropic-result-block>`.

The proxy holds a list of these. On each request, it computes the
active subset (entries whose `anthropic-type` appears in `tools[]`)
and runs the interceptor only for those.

## Config schema

YAML preferred (compose-friendly, comment-friendly). JSON accepted.

```yaml
# maximal-tools.yaml — loaded by the proxy at startup.
mcp_servers:
  fetch:
    transport: stdio
    command: uvx
    args: [mcp-server-fetch]
    # lifecycle: lazy-spawn on first use, kept alive process-wide
    keep_alive: true

  brave:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-brave-search"]
    env:
      BRAVE_API_KEY_FILE: /run/secrets/brave_key
    keep_alive: true

  tavily_remote:
    transport: streamable_http
    url: https://api.tavily.com/mcp
    headers:
      Authorization: Bearer ${env:TAVILY_KEY}

bridge_entries:
  - anthropic_type: web_fetch_20250910
    anthropic_name: web_fetch
    mcp_server: fetch
    mcp_tool: fetch
    input_mapping:
      url: { from: input.url }
      max_length: { from: tool_decl.max_content_tokens, scale: 4 }   # tokens → chars approx
    output_mapping:
      result_kind: web_fetch_tool_result
      content:
        type: web_fetch_result
        url: { from: input.url }
        retrieved_at: { now: iso8601 }
        content:
          type: document
          title: { from: mcp_result.metadata.title, default: "" }
          source:
            type: text
            media_type: text/markdown
            data: { from: mcp_result.content[0].text }
          citations:
            enabled: false
    error_mapping:
      url_not_accessible: [http_error, dns_error, timeout]
      url_not_allowed:    [policy_blocked]
      url_too_long:       [url_length_exceeded]
      invalid_input:      [parse_error, missing_arg]
      unsupported_content_type: [content_type_unsupported]
      max_uses_exceeded:  [usage_cap]
      too_many_requests:  [rate_limited]
      unavailable:        ["*"]   # default
    policy:
      max_uses: { from: tool_decl.max_uses, default: 10 }
      allowed_domains: { from: tool_decl.allowed_domains }
      blocked_domains: { from: tool_decl.blocked_domains }

  - anthropic_type: web_search_20250305
    anthropic_name: web_search
    mcp_server: brave
    mcp_tool: brave_web_search
    input_mapping:
      query: { from: input.query }
      count: { from: tool_decl.max_uses, default: 10 }
      country: { from: tool_decl.user_location.country }
    output_mapping:
      result_kind: web_search_tool_result
      content:
        repeat: { from: mcp_result.content[0].results }   # array fan-out
        as:
          type: web_search_result
          url:    { from: item.url }
          title:  { from: item.title }
          page_age: { from: item.published_date, default: null }
          encrypted_content: { sign_opaque: [item.url, item.title] }
    error_mapping:
      query_too_long:    [query_length_exceeded]
      max_uses_exceeded: [usage_cap]
      too_many_requests: [rate_limited]
      unavailable:       ["*"]
    policy:
      max_uses: { from: tool_decl.max_uses, default: 5 }
      allowed_domains: { from: tool_decl.allowed_domains }
      blocked_domains: { from: tool_decl.blocked_domains }
```

The two `bridge_entries` above re-express `web-tools.md`'s mappings in
this config form. v1 of the proxy ships with this YAML as the
factory default, so the user-visible behavior is unchanged unless the
operator overrides it.

## The mapping language

A small expression vocabulary, intentionally narrow. We avoid invent-
ing a Turing-complete templating language.

**Sources** — what `from:` can reference:

| Source path prefix | Meaning |
|---|---|
| `input.<jsonpath>` | The model's `server_tool_use.input` object |
| `tool_decl.<jsonpath>` | The matching entry in the request's `tools[]` (e.g. `tool_decl.max_uses`, `tool_decl.allowed_domains`) |
| `mcp_result.<jsonpath>` | The MCP `tools/call` response object |
| `mcp_error.<field>` | When MCP returns an error response: `code`, `message`, `data.kind` |
| `item.<jsonpath>` | Inside a `repeat` block, the current iteration element |
| `request.<field>` | Subset of the original Anthropic request (allowlist: `model`, `metadata.user_id`) |
| `env:<NAME>` | Process env var |
| `static:<value>` | Literal value (mostly for clarity) |

**Operators** — what's legal alongside `from:`:

| Operator | Behavior |
|---|---|
| `default: <value>` | Fallback when `from:` resolves to undefined/null |
| `scale: <n>` | Multiply numeric value by `n` |
| `truncate: <n>` | Limit string length |
| `now: iso8601 \| epoch_ms` | Current time at evaluation |
| `sign_opaque: [<sources...>]` | HMAC-signed JSON of the sources, base64; used for `encrypted_content`. Key is `MAXIMAL_OPAQUE_SECRET`. |
| `repeat: { from: ..., as: ... }` | Iterate an array; `as` describes one element |

That's it. No conditionals, no arithmetic beyond `scale`, no string
concat. If a mapping needs more, it should be a code-level extension
(see "Escape hatch" below).

**Result kinds** are restricted to the Anthropic types this spec
covers:
- `web_search_tool_result`
- `web_fetch_tool_result`
- (forward-compat) any future `*_tool_result` once we wire it

`result_kind` selects the wrapper; everything underneath `content:` is
the inner block, validated against the kind's expected schema at
proxy startup.

## Errors

MCP returns JSON-RPC errors with `code` and optional structured
`data`. A backend's `data.kind` (free-form) is used for mapping when
present; otherwise we fall back to a heuristic on `code`.

`error_mapping` is `<anthropic-error-code>: [<list of mcp data.kind
values>]`. The catch-all is `"*"` mapped to whatever (typically
`unavailable`).

The proxy emits the appropriate Anthropic error block (e.g.
`web_search_tool_result_error` or `web_fetch_tool_result_error`)
inside the same content_block_start/stop boundaries — keeping the
SSE event sequence valid.

## MCP server lifecycle

| Transport | Behavior |
|---|---|
| `stdio` | Lazy-spawn on first call; kept alive process-wide if `keep_alive: true`. One process per `mcp_servers.<name>` entry. Restart on crash with exponential backoff (1s, 2s, 4s, max 60s). |
| `streamable_http` | Connect on first call; reuse connection. Reconnect on 5xx/disconnect with same backoff. |
| `sse` (legacy) | Same as `streamable_http`. |

Healthchecks: a periodic `tools/list` call (default every 60s) keeps
the server warm and verifies the connection. Failed healthchecks log
but don't take the server out of rotation — invocation will retry.

Concurrency: each MCP server is single-flight per call but the proxy
multiplexes calls across all configured servers. A request that
needs both `web_search` and `web_fetch` can issue them in parallel.

## Match algorithm

On each Anthropic request:

1. Build the **active set**: for each entry in `bridge_entries`, check
   whether the request's `tools[]` contains an item with `type` ==
   `entry.anthropic_type` AND `name` == `entry.anthropic_name`. If
   yes, the entry is active for this request. Cache the
   `tool_decl` lookup.
2. Stream the upstream Copilot response through the interceptor.
3. When a `server_tool_use` block arrives, match its `name` against
   the active set:
   - No match → pass through unchanged. The client (Claude Code,
     etc.) sees the unresolved block. (Behavior is identical to the
     proxy without this feature.)
   - Match → buffer the block to extract `input`, run policy
     checks, invoke MCP, emit the result block.
4. The interceptor manages `max_uses` counters and domain filters.
   Both are evaluated *before* the MCP call to keep
   policy in the proxy and not in any individual MCP server.

Streaming detail: per `web-tools.md`, Anthropic's server-tool result
blocks are emitted whole. The interceptor pauses upstream
forwarding only for the brief window between
`server_tool_use.content_block_stop` and emitting the result
block; everything before and after streams normally.

## Escape hatch

Some mappings genuinely need more than the language above (e.g.
synthesizing a complex `document` block from a multi-part MCP
response). For those, allow:

```yaml
- anthropic_type: web_fetch_20250910
  anthropic_name: web_fetch
  mcp_server: fetch
  mcp_tool: fetch
  custom_mapper: ./mappers/web_fetch_to_anthropic.ts   # path
```

When `custom_mapper` is present, the proxy imports a function:

```ts
export default async function mapper(
  ctx: MapperContext,
): Promise<AnthropicToolResult>
```

`MapperContext` exposes `input`, `tool_decl`, `mcp_result`,
`mcp_error`, `request`, plus helpers (`signOpaque`, `now`). This is
the same code path the YAML language compiles to under the hood.

The escape hatch is for genuine complexity, not laziness. If a
mapper file appears, it's reviewed like any other code.

## Validation at startup

The proxy validates the whole config before serving:

- Every `mcp_servers.<name>` referenced by a bridge entry exists.
- For stdio MCP servers, the configured command is on PATH (warn,
  not fatal — could be installed lazily).
- For each bridge entry, the `output_mapping.result_kind` exists and
  the inner `content` shape's required fields are filled by some
  source (no JSON path resolves to literal `undefined` at every
  invocation we can predict at config-load time).
- Static cycle check on `repeat` blocks (no infinite expansion).

Validation failures are loud: log and refuse to start.

## Backward compatibility with `web-tools.md`

The spec in `web-tools.md` becomes the **factory default** YAML for
this bridge. A user who configures nothing gets identical behavior
to a hardcoded interceptor. A user who configures *just* a custom
MCP server (e.g. swap Brave for Tavily) only writes the
`mcp_servers` block; `bridge_entries` are inherited from the default.

The `src/routes/messages/web-tools-interceptor.ts`
referenced in `web-tools.md` becomes a thin adapter that loads the
YAML and instantiates the generic interceptor.

## Implementation outline

```
maximal-tools.yaml                              ← user config
└─ loaded at startup → ConfigDoc

ConfigDoc → BridgeRegistry
  ├─ mcp_servers : Map<name, McpClient>
  └─ bridge_entries : List<CompiledEntry>
       └─ CompiledEntry holds:
            anthropic_type, anthropic_name,
            mcp_server (ref), mcp_tool,
            inputMapper, outputMapper, errorMapper, policy

Per-request lifecycle:
  request enters
    → BridgeRegistry.activeFor(req.tools) → List<CompiledEntry>
    → if empty: skip interceptor entirely
  upstream response stream
    → ToolInterceptor.wrap(stream, activeEntries)
       on each server_tool_use block:
         entry = match(block.name, activeEntries)
         if !entry: forward as-is
         else:
           input = JSON.parse(block.partial_json)
           policy.check(entry, input, requestState)  // max_uses, domains
           args = inputMapper(entry, input, tool_decl)
           result | error = mcpClient.call(entry.mcp_tool, args)
           outBlock = outputMapper(entry, ...)
           emit outBlock in correct content_block_start/stop frame
           requestState.uses[entry.id]++
```

`McpClient` is a thin wrapper over the official
`@modelcontextprotocol/sdk` client, parameterized by transport.

## Security

- MCP servers run with the proxy's UID. Stdio servers inherit env;
  use `env:` block to pass secrets, never `args:`.
- `sign_opaque` HMAC key (`MAXIMAL_OPAQUE_SECRET`) must rotate per-
  install; provide a startup warning if the env var is unset.
- Domain allowlists/blocklists are enforced in the proxy, never
  in the MCP server (don't trust the backend to filter).
- The proxy MUST NOT pass the user's Anthropic auth token to MCP
  servers. They get only the args the mapping produced.

## Out of scope (this spec)

- Caching of MCP results (per-URL, time-bound). Worth doing later
  for `web_fetch` cost control.
- Result streaming back to the client (all Anthropic
  server-tool-result blocks are emitted whole today; if Anthropic
  ships a streamable variant, this spec needs an addendum).
- Per-org RBAC on which entries are active. v2 with multi-tenant
  rollout.
- Inbound auth on stdio MCP servers (they're local; we trust local).
  Streamable-HTTP MCP servers carry whatever headers the config
  declares.
- Per-call audit log. Logging hooks exist but the schema and sink
  are a separate concern.
- The corresponding outbound MCP server route on the proxy
  ("Extension B" / `tool-hub`). Will share executors with this
  spec; will not change the bridge entries' shape.

## Open decisions

1. **YAML vs. JSON for the config file.** YAML reads better, JSON has
   simpler parsers. Recommend YAML with JSON fallback for ops
   tooling.
2. **Exit on validation failure vs. start with degraded entries.**
   Recommend exit — silent degradation is worse than visible failure
   for an internal tool.
3. **Where the YAML lives.** Default `~/.config/maximal/tools.yaml`,
   overridable via `--tools-config <path>`. Container path:
   `/etc/maximal/tools.yaml` mounted at runtime.
4. **`encrypted_content` format.** v1: `base64(json({url, fetched_at,
   provenance}))` HMAC'd with `MAXIMAL_OPAQUE_SECRET`. The model
   round-trips it without inspecting; the proxy verifies on
   subsequent turns and rejects forgeries. Worth specifying the
   exact wire format in a follow-up section before implementing.
5. **Custom mapper sandbox.** `custom_mapper: ./mappers/foo.ts`
   imports arbitrary code. Recommend documenting that custom
   mappers run in-process with full proxy privileges and require
   review like any other code. No vm-sandboxing in v1.
6. **Concurrency limits.** Should the proxy gate parallel calls to
   the same MCP server? Default: yes, with a per-server semaphore
   (default size 4, configurable per `mcp_servers.<name>.max_inflight`).

## References

- `docs/spec/archive/web-tools.md` — the surface this spec generalizes
- MCP protocol:
  https://modelcontextprotocol.io/specification/draft
- MCP TypeScript SDK:
  https://github.com/modelcontextprotocol/typescript-sdk
- Anthropic web tool docs:
  https://platform.claude.com/docs/en/agents-and-tools/tool-use/
- caozhiyuan/copilot-api streaming translation:
  `src/routes/messages/stream-translation.ts`
