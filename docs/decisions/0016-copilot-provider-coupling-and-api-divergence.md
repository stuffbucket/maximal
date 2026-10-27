# ADR-0016: Copilot provider coupling and API divergence

**Status:** Accepted — documentation of current state / knowledge capture.
**Date:** 2026-07-06.

## Problem

The proxy's request-handling engine was designed against GitHub Copilot's
API as it stood in early 2026. Copilot then shipped a run of changes in
mid-2026 — per-token billing (June 1), provider-split prompt caching
(June 17), tool deferral / `tool_search`, an "Auto" model router, and a
Responses-API WebSocket transport. This ADR records where Maximal's
engine matches that contract, where it still diverges, and which code
encodes Copilot-only assumptions, so the analysis is not re-derived each
session.

## Context: this is all Copilot-specific

The core engine — `src/routes/messages/`, `src/services/copilot/`, and
`src/lib/config/api-config.ts` — is coupled to **GitHub Copilot as the sole upstream
provider**. Every translation decision, every header, and every cost
assumption below encodes *Copilot's* contract, not a general one:

- `src/lib/config/api-config.ts` hardcodes Copilot editor/plugin identities, the
  Copilot API-version token, and the Copilot host-discovery precedence.
- `src/services/copilot/create-messages.ts` speaks Copilot's `/v1/messages`
  dialect (its `anthropic-beta` allowlist, its header shape).
- `src/routes/messages/responses-translation.ts` speaks Copilot's
  `/responses` dialect (its `temperature:1` requirement, its
  `max_output_tokens` floor).
- `src/lib/token-usage/` prices usage against Copilot's billing signals.

As we add other providers — local models (llama.cpp / Ollama) or other
hosted APIs — **none of these decisions are safe to assume global.** A local
model has no premium-request concept, no `anthropic-beta` negotiation, no
`/responses` endpoint, and its own (or zero) cost model.

**This ADR does not build a provider abstraction.** It recommends that
provider-specific behavior be *recognized as a seam* — labelled and
documented as Copilot-specific — so that when a second provider lands, the
right code is obviously the code that has to fork, and nobody mistakes a
Copilot quirk for an invariant.

## The divergences

Each item below states what Copilot does, what we do, and the remaining
risk. Code comments cite these by number (e.g. "ADR-0016 div. 1"), so the
numbering is stable.

### 1. Billing signal — *resolved*

**Copilot now:** billing is per-token "AI credits" (AIU). Premium-requests
+ per-model multipliers are **legacy**, retained only for annual plans.
`/models` exposes **`token_prices`** (per-1M rates: input / cached /
cache-write / output); `is_premium === false` no longer means "free".

**We do:** `src/services/copilot/get-models.ts` types
`billing.token_prices` alongside the legacy `is_premium` / `multiplier`.
`resolveIsPaid()` in `src/lib/token-usage/index.ts` uses `token_prices` as
the primary paid/free signal and falls back to `is_premium` only when
`token_prices` is absent or unusable. Recorded cost comes from the
upstream `copilot_usage.total_nano_aiu` when present (`withCopilotCost()`).
This mapping is the Copilot-specific pricing seam.

### 2. Prompt caching is provider-split — *GPT side resolved; Claude side latent*

- **Claude `/v1/messages`:** caller-controlled `cache_control` ephemeral
  breakpoints, **max 4**, best hit-rate when ordered tools → system →
  messages. Our proxy **forwards Claude Code's breakpoints as-is** and
  only sanitizes them: `stripCacheControl` (`src/routes/messages/preprocess.ts`)
  strips the `scope` subfield (rejected by Copilot's Messages API) and
  removes `cache_control` nested inside `tool_result.content[]` items. It
  does **not** enforce the ≤4 cap and does **not** reorder. Reference:
  microsoft/vscode-copilot-chat `messagesApi.ts` (`maxCacheBreakpoints = 4`).
- **GPT `/responses`:** automatic server-side prefix caching, extendable
  via `prompt_cache_retention`. The Responses flow sets it from the
  opt-in `promptCacheRetention` config (`"in_memory"` or `"24h"`;
  `getPromptCacheRetention()`), applied in `handleWithResponsesApi()`
  after translation. Payloads also carry `prompt_cache_key` and
  `store: false`.

**Risk:** on the Claude path we rely on the client sending ≤4 well-placed
breakpoints; if it sends more, or in a bad order, Copilot's behavior
(reject vs. silently drop) is upstream-defined and unhandled.

### 3. Tool deferral / `tool_search` not leveraged — *latent, opportunity cost*

**Copilot now:** supports `defer_loading: true` on tool definitions plus
embedding-guided `tool_search`, reported at ~18% token reduction for
Anthropic models.

**We do:** the only `defer_loading` reference is a *read* on one IDE tool
in `sanitizeIdeTools()` (`preprocess.ts`). We never *set* `defer_loading` and never emit a
`tool_search` tool.

**Risk:** pure opportunity cost — larger prompts than necessary. Not broken,
but leaves a documented efficiency win on the table.

### 4. Copilot Auto routing and Claude Code Auto permissions are separate

Copilot's Auto router selects a model when its own clients do not name one.
Maximal always sends a concrete Copilot model, so that router does not run.

Claude Code's Auto permission mode is different: it can ask an LLM gateway for
server-side safety decisions during normal Messages requests. Copilot does not
document this safeguard contract, and Maximal has not verified that Copilot's
native `/v1/messages` endpoint returns those decisions. Maximal must not
fabricate them.

While Maximal owns Claude Code routing, it therefore sets Anthropic's temporary
`CLAUDE_CODE_AUTO_MODE_SERVER=0` fallback. This suppresses the unsupported
server review request and its eligibility warning; Claude Code continues using
its local classifier. It does **not** enable no-charge server classification.
The setting is snapshotted and reverted with `ANTHROPIC_BASE_URL` and
`apiKeyHelper`, without overwriting or removing a user-owned value.

The native Messages path passively preserves unknown request fields such as
`safeguards` and unknown response fields such as `safeguard_results`. That
transport property is not evidence that Copilot evaluates safeguards, and it
does not remove the need for the existing Copilot `anthropic-beta` allowlist.

### 5. WebSocket transport — *latent, opportunity cost*

**Copilot now:** offers a Responses-API WebSocket transport (GPT-5.2+),
reported −16–19% TTFT.

**We do:** plain HTTP SSE for streaming.

**Risk:** opportunity cost only (latency). No correctness impact.

### 6. Rate limits — *working, no adaptive backoff*

**Copilot now:** returns `429` + `Retry-After` on throttle, plus
`x-usage-ratelimit-session` / `x-usage-ratelimit-weekly` quota headers.

**We do:** relay `Retry-After` (and `x-*` headers) on 429
(`relayRetryHeaders()` in `src/lib/errors/error.ts`) and parse and log the
two quota headers (`src/lib/errors/copilot-rate-limit.ts`). We do **not** do adaptive or
proactive backoff off the quota signal.

**Risk:** low — reactive handling is correct. The gap is that we surface
quota but never pre-emptively slow down before hitting the wall.

### 7. Hardcoded contract — *latent-rot, highest breakage surface*

A cluster of Copilot-contract constants is pinned in source and will silently
rot when Copilot moves them:

- `src/lib/config/api-config.ts`: `API_VERSION` (`x-github-api-version`);
  `COPILOT_VERSION` (editor-plugin `copilot-chat/<v>` and user-agent
  `GitHubCopilotChat/<v>`); the Claude Code compatibility user-agent
  `CLAUDE_AGENT_USER_AGENT`; the opencode identity strings.
- `src/services/copilot/create-messages.ts`: `anthropic-beta` date tokens —
  `INTERLEAVED_THINKING_BETA`, `ADVANCED_TOOL_USE_BETA`,
  `CONTEXT_MANAGEMENT_BETA`, and the beta allowlist.
- `src/routes/messages/responses-translation.ts`: `temperature: 1` and the
  `max_output_tokens` floor of `12800` in
  `translateAnthropicMessagesToResponsesPayload()`.

**Risk:** these are the classic silent-rot surface. A stale
api-version/editor-version has produced hard upstream failures before (an
endpoint-migration 421). When Copilot rotates a beta token or bumps a
required version, these break with upstream errors that look unrelated to
a version pin. Read the current values from source; do not copy them into
docs.

Context-editing support is not inferred from the identity pins. Copilot's
catalog may omit `context_editing` even where the endpoint accepts some
strategies, so Maximal treats absent metadata as expected support, honors
an explicit `false`, and caches only strategy-specific rejections from real
requests for the process lifetime; a context-specific `400` is retried once
without the feature (see `docs/spec/wire/auth-transport-wire-prd.md` →
*Messages context-editing compatibility*).

## Decision

1. **Capture this as earned knowledge (this ADR).** Point at this record
   instead of re-deriving the billing/caching divergence.

2. **Treat provider-specific behavior as a seam, not an abstraction.** Do
   **not** build a general provider interface now. Instead, keep the
   Copilot-specific decisions labelled as such (naming, comments, and this
   ADR) so the fork points are obvious when a second provider arrives. The
   engine is Copilot-coupled by design today; that is acceptable — what is
   not acceptable is *forgetting* it is Copilot-specific.

3. **Open follow-up workstreams** (for triage, not committed to here):
   - **Claude caching.** Decide whether to enforce the ≤4 breakpoint cap /
     ordering on the Claude path. (Divergence 2.)
   - **Tool deferral.** Evaluate `defer_loading` + `tool_search` for the
     token reduction. (Divergence 3.)
   - **Contract-rot guard.** A lightweight check or documented refresh
     procedure for the pinned version/beta constants. (Divergence 7.)

## Consequences

- **The divergence is documented, not folklore.** `token_prices` is the
  primary paid/free signal in `src/lib/token-usage/`; `is_premium` is a
  legacy fallback only.
- **The pinned constants are known-fragile.** Divergence 7's list is the
  first place to look when Copilot returns unexplained 4xx after an upstream
  change.
- **Adding a second provider is a design event, not a refactor.** A future
  local-model or hosted-API provider will need its **own** decisions for
  every domain above and must not inherit Copilot's:
  - **Billing/cost:** local models are free (electricity aside); other hosted
    APIs have their own price sheets. Neither has premium-requests or AIU.
  - **Caching:** local runtimes have their own KV-cache reuse semantics (or
    none exposed); `cache_control` breakpoints and `prompt_cache_retention`
    are Copilot/Anthropic-specific and won't transfer.
  - **Headers/contract:** the `anthropic-beta` tokens, editor identities, and
    API-version pin are meaningless off Copilot.
  - **Transport:** SSE vs WebSocket vs local IPC is per-provider.
  - **Rate limits:** local models throttle on hardware, not `429`
    + `Retry-After`.

  When that day comes, this ADR is the checklist of what must fork.

## Sources

Primary GitHub / Microsoft sources, all confirmed against the cited code:

- Token-efficiency overview — github.blog, *getting more from each token*.
- Provider-split prompt caching — code.visualstudio.com, *2026/06/17,
  improving token efficiency*.
- Billing model change (per-token AIU; premium-requests legacy) —
  github.blog, *2026-06-01* billing changelog.
- Models & pricing / `token_prices` — docs.github.com, models-and-pricing.
- Claude `/v1/messages` breakpoint cap (`maxCacheBreakpoints = 4`) —
  microsoft/vscode-copilot-chat `messagesApi.ts`.
- Claude Code Auto mode classifier billing and gateway behavior —
  code.claude.com docs, *Auto mode classifier request charges*, *LLM gateway
  protocol*, and *Permission modes: server-side classifier review*.
