# Research: GitHub Copilot Anthropic Messages API context management

Started: 2026-09-19T16:58:14-07:00 | Completed: 2026-09-19

## Problem

Maximal proxies Claude Code's Anthropic-shaped requests to GitHub Copilot's
`/v1/messages` endpoint. Claude Code can send a top-level
`context_management` object with the `context-management-2025-06-27` beta
token. GitHub Copilot issue reports showed those requests failing, while the
live model catalog did not consistently advertise whether context editing was
supported. The investigation needed to determine whether stale client identity
headers caused the failures and how Maximal should handle capability drift
without a static model allowlist.

## Sources

Primary sources used:

- Anthropic context editing documentation:
  https://platform.claude.com/docs/en/build-with-claude/context-editing
- Anthropic beta-header documentation:
  https://platform.claude.com/docs/en/api/beta-headers
- VS Code's inbound Anthropic beta filtering:
  https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/platform/agentHost/node/claude/anthropicBetas.ts
- VS Code Copilot Chat context-editing request handling:
  https://raw.githubusercontent.com/microsoft/vscode/main/extensions/copilot/src/platform/endpoint/node/messagesApi.ts
- VS Code Copilot Chat capability handling:
  https://raw.githubusercontent.com/microsoft/vscode/main/extensions/copilot/src/platform/networking/common/anthropic.ts
- Copilot Chat marketplace version:
  https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat
- VS Code stable release API:
  https://update.code.visualstudio.com/api/releases/stable
- GitHub REST API versions:
  https://docs.github.com/en/rest/about-the-rest-api/api-versions

No community awesome list was used because the relevant behavior is an
upstream wire contract; primary implementation and product sources were more
authoritative.

## Upstream contract findings

Anthropic Messages context editing uses:

```json
{
  "context_management": {
    "edits": [{ "type": "clear_tool_uses_20250919" }]
  }
}
```

with `anthropic-beta: context-management-2025-06-27`. Relevant edit types are
`clear_tool_uses_20250919` and `clear_thinking_20251015`. Anthropic also
documents server-side compaction, but that is a distinct feature.

Microsoft's current capability model recognizes these server-declared support
fields: `tool_calls`, `parallel_tool_calls`, `vision`, `streaming`,
`structured_outputs`, `prediction`, `adaptive_thinking`,
`min_thinking_budget`, `max_thinking_budget`, `reasoning_effort`, `tool_search`,
and `context_editing`. A declaration describes upstream support; it does not
assert that Maximal implements or translates the feature.

The live Copilot Claude catalog exposed `adaptive_thinking`, thinking budget,
parallel tool calls, reasoning effort, streaming, structured output, tool calls,
and vision fields. It did not advertise `context_editing` or `tool_search` for
any tested Claude model. Absence therefore cannot safely mean unsupported.

## Live smoke tests

The user authorized a small live smoke test. Requests were non-streaming,
limited to `max_tokens: 1`, did not print response content or credentials, and
reported only model IDs, status, and error classification.

| Model              |              Baseline | `clear_tool_uses_20250919` |   `clear_thinking_20251015` |
| ------------------ | --------------------: | -------------------------: | --------------------------: |
| `claude-opus-4.7`  |                   200 |                        200 | 400 `invalid_request_error` |
| `claude-opus-4.8`  |                   200 |                        200 | 400 `invalid_request_error` |
| `claude-haiku-4.5` |                   200 |                        200 | 400 `invalid_request_error` |
| `claude-opus-5`    | not separately probed |      not separately probed |                         200 |
| `claude-sonnet-5`  |                   200 |      not separately probed |                         200 |

Additional observations:

- The exact issue shape `context_management: { edits: [] }` returned 200 on
  Sonnet 5 and Opus 4.7, showing that backend behavior can change without a
  model ID change.
- Refreshing identity headers did not change the context-editing outcomes.
- Microsoft's model-name fallback was already stale: it omitted live Opus 5 and
  Sonnet 5 even though both accepted thinking clearing.
- The installed Claude Code binary reported `2.1.278`. Copilot Chat `0.48.1`,
  VS Code `1.138.0`, and Copilot CAPI `2026-08-01` were independently verified.
  The `agent-sdk/0.2.278` portion of Maximal's compatibility user agent follows
  its existing mirrored-version convention; it was not independently exposed
  by the compiled Claude Code binary.

## Approaches considered

### Strip context management universally

Rejected. It avoids failures but silently removes a supported feature from
models and strategies that accept it.

### Keep a static model allowlist

Rejected. The upstream fallback was already stale, catalog metadata was absent,
and the same exact model can change behavior as Copilot's backend evolves.

### Send separate synthetic capability probes

Rejected as the default runtime path. A preflight adds latency and quota cost,
and schema acceptance does not prove that an edit actually fires.

### Learn from the first real request

Selected. The real request is the probe. A successful response records
acceptance. A context-specific 400 records rejection and triggers one fallback
attempt with context editing removed.

## Recommendation and implementation

Keep three capability layers separate:

1. **Advertised:** the upstream model catalog's `supports.context_editing`
   declaration when present.
2. **Implemented:** Maximal's ability to preserve and forward the Messages
   request shape and paired beta token.
3. **Observed:** current endpoint acceptance or rejection learned from actual
   requests.

The v0.4.42 implementation:

- preserves context editing when advertised support is absent;
- suppresses it when upstream explicitly advertises `false`;
- treats a missing rejection-cache entry as expected support and records no
  positive state after successful acceptance;
- retries once only when a 400 response body explicitly names
  `context_management`;
- removes the body field and only `context-management-2025-06-27`, preserving
  unrelated beta tokens;
- caches only rejections in memory for the process lifetime by account, Copilot
  host, exact model ID, and normalized full edit-set signature, including
  strategy parameters;
- reports advertised support and current-catalog rejection entries separately
  through authenticated diagnostics;
- leaves unrelated 400 responses unchanged.

This cache has no arbitrary TTL. Exact model IDs define the compatibility
boundary, so a newly published model naturally starts with expected support.
Process-local storage clears rejections across upgrades or restarts. Copilot can
still change backend validation without changing a model ID, as the empty-edit
result demonstrates; a restart is then the recovery boundary for a previously
rejected signature.

## Risks and checks

- A context-related error whose body does not mention `context_management` will
  not trigger fallback. This is deliberate to avoid masking unrelated errors.
- A successful response proves endpoint acceptance, not that an edit threshold
  was reached and content was actually cleared.
- The first rejected request for a new account/host/model/signature incurs one
  extra upstream attempt; subsequent requests in that process omit the rejected
  feature immediately.
- Catalog `false` is authoritative for request suppression, while a catalog
  omission remains unknown.
- Diagnostics omit account identity even though account is part of the internal
  cache key.

Checks cover strategy-parameter normalization, rejection-only storage without
time-based expiry, selective retry, retention of unrelated beta tokens, cached
rejection reuse, unrelated 400s, explicit advertised `false`, and authenticated
diagnostics reporting.

## Research checks

- [x] Freshness: versions and live endpoint behavior checked on 2026-09-19.
- [x] Depth: official docs, Microsoft source, live catalog, and live requests.
- [x] Outlier: same model accepted empty edits and tool-use clearing but rejected
      thinking clearing.
- [x] Primary sources preferred over aggregators.

## Feedback

usefulness: high | implemented: yes | result: strategy-specific adaptive fallback
