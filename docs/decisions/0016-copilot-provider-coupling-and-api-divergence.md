# ADR-0016: Copilot provider coupling and API divergence

**Status:** Accepted — documentation of current state / knowledge capture.
**Date:** 2026-07-06.
**Authors:** consolidated from a parallel investigation (billing, caching, transport, contract-rot), all findings confirmed against code + primary GitHub sources.

## Problem

The proxy's request-handling engine was designed against GitHub Copilot's
API as it stood in early 2026. Copilot then shipped a run of changes in
**mid-2026** — a new billing model (June 1), provider-split prompt caching
(June 17), tool deferral / `tool_search`, an "Auto" model router, and a
Responses-API WebSocket transport. Our engine predates all of them.

The result is that **two domains have quietly diverged** from the live
upstream: **cost accounting** (we still key on legacy premium-request /
multiplier signals) and **prompt caching** (we forward Claude Code's
breakpoints unpoliced and leave the GPT-side retention knob commented out).
Some of this is already-wrong; most is latent rot that will bite the next
time Copilot deprecates a field we hardcode.

Compounding the technical drift: this knowledge kept getting **re-derived
from scratch each session** — someone would trace the billing code, re-read
the changelogs, re-confirm which caching path applies to which model family,
and reach the same conclusions. This ADR captures it once so it stops being
rediscovered.

## Context: this is all Copilot-specific

The core engine — `src/routes/messages/`, `src/services/copilot/`, and
`src/lib/api-config.ts` — is coupled to **GitHub Copilot as the sole upstream
provider**. Every translation decision, every header, and every cost
assumption below encodes *Copilot's* contract, not a general one:

- `src/lib/api-config.ts` hardcodes Copilot editor/plugin identities, the
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

Each item below states what Copilot does now, what we do, the file
reference, the risk, and whether it is **already-broken** or **latent-rot**.

### 1. Billing model rot — *already-broken*

**Copilot now:** As of **2026-06-01**, Copilot billing is per-token "AI
credits" (AIU). Premium-requests + per-model multipliers are **legacy**,
retained only for annual plans. Copilot exposes a new **`token_prices`**
field on `/models` (per-1M rates: input / cached / cache-write / output).
`gpt-5-mini` is **not** free — roughly $0.25/1M in, $2.00/1M out.

**We do:** cost logic keys on `billing.is_premium` / `billing.multiplier`.
`src/services/copilot/get-models.ts:117-119` types only `billing.{is_premium,
multiplier}`; `token_prices` is **not present anywhere** in `src/`.
`resolveIsPremium` (`src/lib/token-usage/index.ts:132-138`) maps
`is_premium` → 1/0/null, and `src/lib/token-usage/store.ts` persists that
`is_premium` column as the cost signal.

**Risk:** `is_premium === false` no longer means "free," so any
free-vs-paid inference is wrong for the current billing regime — a paid
model (gpt-5-mini) reads as free. The accurate per-token rates we'd need
(`token_prices`) are already on the wire and simply not consumed.

### 2. Prompt caching is provider-split — *latent-rot, one side already inert*

Copilot's **2026-06-17** change made caching behave differently per model
family:

- **Claude `/v1/messages`:** caller-controlled `cache_control` ephemeral
  breakpoints, **max 4**, best hit-rate when ordered tools → system →
  messages (~94% when well-placed). Our proxy **forwards Claude Code's
  breakpoints as-is** and only sanitizes them: `stripCacheControl`
  (`src/routes/messages/preprocess.ts:512`) strips the `scope` subfield
  (rejected by Copilot's Messages API) and removes `cache_control` nested
  inside `tool_result.content[]` items. It does **not** enforce the ≤4 cap
  and does **not** reorder. Reference: microsoft/vscode-copilot-chat
  `messagesApi.ts` (`maxCacheBreakpoints = 4`).
- **GPT `/responses`:** automatic server-side prefix caching, extendable via
  the `prompt_cache_retention: "24h"` body param. Our payload sets
  `store: false` and has `prompt_cache_retention` **commented out** with the
  note *"not work in gpt-5.4"*
  (`src/routes/messages/responses-translation.ts:87`, alongside `store: false`
  at line 89).

**Risk:** on the Claude path we rely on the client sending ≤4 well-placed
breakpoints; if it sends more, or in a bad order, Copilot's behavior (reject
vs. silently drop) is upstream-defined and unhandled — a caching regression
we would not detect. On the GPT path we are leaving a documented cache
extension permanently off behind a stale gpt-5.4 note.

### 3. Tool deferral / `tool_search` not leveraged — *latent, opportunity cost*

**Copilot now:** supports `defer_loading: true` on tool definitions plus
embedding-guided `tool_search`, reported at ~18% token reduction for
Anthropic models.

**We do:** the only `defer_loading` reference is a *read* on one IDE tool —
`preprocess.ts:472` (`tool.name === IDE_EXECUTE_CODE_TOOL &&
!tool.defer_loading`). We never *set* `defer_loading` and never emit a
`tool_search` tool.

**Risk:** pure opportunity cost — larger prompts than necessary. Not broken,
but leaves a documented efficiency win on the table.

### 4. Auto mode / HyDRA routing — *no-op for us, documented to prevent confusion*

**Copilot now:** ships an "Auto" model router (Chat / CLI / IDE surfaces),
carrying a 10% billing discount and cache-awareness.

**We do:** always name a specific model in every API call. **Naming a model
bypasses Auto** — the router only engages when the caller declines to pick.

**Risk:** none functionally. Documented here so nobody conflates Copilot's
product-level "Auto mode" with **our** internal request classifier / model
dispatch. They are unrelated; our classifier picks a concrete model, which is
exactly what turns Auto *off* upstream.

### 5. WebSocket transport — *latent, opportunity cost*

**Copilot now:** offers a Responses-API WebSocket transport (GPT-5.2+),
reported −16–19% TTFT.

**We do:** plain HTTP SSE for streaming.

**Risk:** opportunity cost only (latency). No correctness impact.

### 6. Rate limits — *working, no adaptive backoff*

**Copilot now:** returns `429` + `Retry-After` on throttle, plus
`x-usage-ratelimit-session` / `x-usage-ratelimit-weekly` quota headers.

**We do:** forward `Retry-After` (and `x-*` headers) on 429
(`src/lib/error.ts:78-81`) and parse the two quota headers
(`src/lib/copilot-rate-limit.ts:16-17`). We do **not** do adaptive or
proactive backoff off the quota signal.

**Risk:** low — reactive handling is correct. The gap is that we surface
quota but never pre-emptively slow down before hitting the wall.

### 7. Hardcoded contract — *latent-rot, highest breakage surface*

A cluster of Copilot-contract constants is pinned in source and will silently
rot when Copilot moves them:

- `src/lib/api-config.ts`: API version `2025-10-01`; editor-plugin
  `copilot-chat/0.46.0`; user-agent `GitHubCopilotChat/0.46.0`
  (lines 149-155).
- `src/services/copilot/create-messages.ts`: `anthropic-beta` date tokens —
  `interleaved-thinking-2025-05-14` (line 32),
  `advanced-tool-use-2025-11-20` (line 33),
  `context-management-2025-06-27` (line 36).
- `src/routes/messages/responses-translation.ts`: `temperature: 1` (line 80)
  and the `max_output_tokens` floor of `12800` (line 82).

**Risk:** these are the classic silent-rot surface. A stale
api-version/editor-version has already been observed to produce hard upstream
failures (the 421 endpoint-migration incident). When Copilot rotates a beta
token or bumps a required version, these break with upstream errors that look
unrelated to a version pin.

## Decision

1. **Capture this as earned knowledge (this ADR).** Stop re-deriving the
   billing/caching divergence every session; point at this record.

2. **Treat provider-specific behavior as a seam, not an abstraction.** Do
   **not** build a general provider interface now. Instead, keep the
   Copilot-specific decisions labelled as such (naming, comments, and this
   ADR) so the fork points are obvious when a second provider arrives. The
   engine is Copilot-coupled by design today; that is acceptable — what is
   not acceptable is *forgetting* it is Copilot-specific.

3. **Enumerate the follow-up workstreams — do not implement them here:**
   - **Billing signal migration.** Consume `token_prices` from `/models` and
     price usage per-token; retire `is_premium`/`multiplier` as the primary
     cost signal (keep as legacy-plan fallback). (Divergence 1.)
   - **/responses caching.** Re-test `prompt_cache_retention` against the
     current GPT model and remove or act on the stale "gpt-5.4" note; decide
     whether to enforce the ≤4 breakpoint cap / ordering on the Claude path.
     (Divergence 2.)
   - **Warm-up short-circuit / tool deferral.** Evaluate `defer_loading` +
     `tool_search` for the token reduction. (Divergence 3.)
   - **Contract-rot guard.** A lightweight check or documented refresh
     procedure for the pinned version/beta constants. (Divergence 7.)

   These are listed for triage, not committed to in this ADR.

## Consequences

- **The divergence is now documented, not folklore.** Cost numbers derived
  from `is_premium` should be read as *legacy-regime* until workstream 1
  lands; readers of `src/lib/token-usage/` should know `token_prices` is the
  real signal.
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
