# Keeping current with model + protocol changes — strategy

Status: Proposed (not scheduled), 2026-05-04.
Owner: bstucker.
Scope: How the proxy stays correct as Anthropic, OpenAI, and GitHub
Copilot ship new models, beta headers, and tool versions. Strategy
doc — informs a future PRD when scheduled.

## TL;DR

- Anthropic, OpenAI, and Copilot release on a monthly-ish cadence.
  Each release can break the proxy in three ways: an unrecognized
  model ID, an unsupported tool-type string (e.g.
  `web_search_20260209`), or a new beta header. Today the proxy has
  no automated way to notice any of these — it fails when a user
  hits it.
- Today protocol literals live in 9+ files. Five regex patterns in
  `src/lib/models.ts` cover Claude ID rewriting; tool versions are
  hardcoded in `web-tools-vocab.ts`; beta headers are parsed inline
  in handlers; OpenAI surface drift is mostly inherited from
  upstream `caozhiyuan/copilot-api`. Adding a new protocol string
  requires touching multiple files and missing one is silent.
- Strategy: a five-layer system — **detect** changes upstream,
  **register** them in one place, **validate** at request time,
  **capture** unknowns from real traffic, **test** behavior at the
  registry level. Daily logs and the deferred observability PRD do
  most of the heavy lifting once they're hooked up.
- Estimate ~3 days when scheduled. Single PRD. Pre-requisite is
  finishing the cleanup PRD's deferred items only insofar as the
  registry would benefit from `RuntimeContext` — but the strategy is
  shippable on the current singleton model.

## Problem

Three release cadences land changes the proxy has to keep up with:

| Source | Changes per release | Failure mode if missed |
|---|---|---|
| **Anthropic** | New model IDs (`claude-opus-4.7`), new tool versions (`web_search_20260209`), new `anthropic-beta` values (`claude-code-20250219`, `effort-2025-11-24`), occasional endpoint-shape tweaks | Client request rejected by Copilot upstream because the proxy didn't strip / rewrite the new protocol string |
| **OpenAI** | New model IDs (`gpt-5.5`), new Responses-API features, new tool conventions | Codex / non-Anthropic client gets a 400 from Copilot upstream |
| **Copilot** | New models in `/models` listing, occasional removal, new `supported_endpoints` flags, new beta paths | Models silently disappear from `/v1/models`; routing falls through to wrong handler |

Today the proxy has **no automated way to detect any of these.** A
new model lands → user tries it → request fails → user opens an
issue → we go fix the regex / add the tool version / add the beta
header passthrough. Manual, reactive, error-prone.

The state today (evidence base for the strategy):

- **`src/lib/models.ts`** has 5 regex patterns covering the
  dot/dash/dash-date forms. Adding a 6th form requires editing the
  parser and hoping no test breaks.
- **`src/lib/anthropic-id-rewrite.ts`** has its own three regexes
  (`FORWARD_RE`, `REVERSE_RE`, `VARIANT_RE`) plus a hardcoded
  `SENTINEL_DATE = "20260301"`. This file does the actual
  request-time rewriting — the `models.ts` parser is a parallel,
  unrelated code path that isn't called from this rewrite layer.
- **`src/routes/messages/web-tools-vocab.ts`** hardcodes
  `web_search_20250305` and `web_fetch_20250910`. The rewriter
  matches these literally; Anthropic's `web_search_20260209` would
  pass through unrewritten and Copilot would reject it.
- **9+ files** reference one or more of `TOOL_TYPE`,
  `web_search_2*`, `web_fetch_2*`, `anthropic-beta`,
  `claude-code-20*`. No single source of truth for "what protocol
  strings does this proxy understand?"
- **No diff against upstream model lists.** We fetch Copilot's
  `/models` once at startup and that's it.
- **The daily log captures every payload** — it has the data we'd
  want to mine for unrecognized strings, but no one reads it
  systematically.

### How the model cache is built today

Walking the actual flow makes the consolidation target concrete:

1. **Fetch.** `src/services/copilot/get-models.ts:7` issues a single
   `GET ${copilotBaseUrl(state)}/models` with `copilotModelsHeaders`.
   Base URL depends on account type — individual / business /
   enterprise / opencode-OAuth — five branches in
   `src/lib/api-config.ts:156`.
2. **Filter + cache.** `src/lib/utils.ts:23 cacheModels()` keeps only
   `model_picker_enabled || capabilities.type === "embeddings"` and
   writes via `setModels()` into both legacy `state.models` and the
   new `SingletonCache` (post-`3c1f749` so `/_debug/state` shows
   refresh time + count).
3. **When.** Once at startup (`runServer()` in `start.ts`), with a
   lazy fallback in `routes/models/route.ts:12-15` if `state.models`
   is unset on a `GET /v1/models`. **No refresh after that** — stale
   until process restart. (Tracked as deferred item "Models-list
   refresh strategy" in the cleanup PRD.)
4. **Outbound `/v1/models`.** `routes/models/route.ts` filters
   variant IDs (`isVariantId`), rewrites Anthropic IDs via
   `forwardId` (`claude-opus-4.6` → `claude-opus-4-6-20260301`), and
   reshapes each entry. Hides Copilot's effort/context-window
   suffixes from the picker.
5. **Inbound routing.** When a request arrives, `reverseId` undoes
   the forward rewrite, then `pickCopilotVariantId` consults the
   `state.models` ID list as the routing oracle: `effort: "high"`
   → tries `<base>-high`, `longContext: true` → tries
   `<base>-1m-internal` then `<base>-1m`, falls back to base if
   neither is in the cached list.

So `state.models` is doing two jobs: powering the public listing
*and* validating variant routing. Both jobs share the same
hand-written regexes plus a hardcoded sentinel date plus a hardcoded
variant suffix list (`low|medium|high|xhigh|max|1m` with optional
`-internal`).

### Where today's code maps to the proposed registry

Concrete migration targets when L2 is built:

| Today | Registry replacement |
|---|---|
| `src/lib/models.ts` 5-regex `parseClaudeId` | `parseModelId(input)` reads from `models[]` table; new model = one row |
| `anthropic-id-rewrite.ts` `FORWARD_RE` / `REVERSE_RE` | Derived from registry's family + version + dash-date convention; round-trip is a registry method, not a hand-written regex pair |
| `anthropic-id-rewrite.ts` `SENTINEL_DATE = "20260301"` | Registry constant; can be a per-model field if Anthropic ever varies it |
| `anthropic-id-rewrite.ts` `VARIANT_RE` (`low|medium|high|xhigh|max|1m`) | Registry's `variantSuffixes[]` table; routing logic walks the table |
| `pickCopilotVariantId` candidate-building (`-high`, `-1m-internal`, `-1m`) | Registry's variant-priority table per family |
| `web-tools-vocab.ts` `TOOL_TYPE.webSearch = "web_search_20250305"` | Registry's `toolVersions[].latest` per tool name; rewriter accepts any in `supported[]` |
| `state.models` as routing oracle | Stays — but its values are validated against the registry at refresh time, surfacing diffs through L1 |

Net effect: ~150 LOC of regex deletion + ~250 LOC of registry table.
Code is more, total complexity is less, and "what does this proxy
understand" is one file lookup.

## Strategy: five layers

### Layer 1 — Detection (upstream)

Notice when something has changed before users hit it. Two tiers,
the in-proxy one is primary.

#### L1a. Lazy refresh on activity (in-proxy, primary)

The `SingletonCache` wrapping `state.models` already tracks
`loaded_at_ms`. Add a tiny middleware that runs at request entry:

```ts
// pseudocode
const STALE_AFTER_MS = 6 * 60 * 60 * 1000          // 6 hours
const JITTER_MS      = 2  * 60 * 60 * 1000         // ±1 hour (2h total spread)

function isStale(): boolean {
  const loaded = modelsCache.metrics().loaded_at_ms
  if (loaded === null) return false                // not yet primed by startup
  const jitter = (hash(state.macMachineId) % JITTER_MS) - JITTER_MS / 2
  return Date.now() > loaded + STALE_AFTER_MS + jitter
}

function refreshIfStale(): void {
  if (!isStale() || refreshInFlight) return
  refreshInFlight = true                            // prevents thundering herd
  void cacheModels().finally(() => { refreshInFlight = false })
}
```

Properties:

- **Activity-driven.** No timer; nothing fires when the proxy is
  idle. A proxy left running over the weekend stays on its
  Friday-afternoon cache until Monday's first request.
- **Stale-while-revalidate.** The triggering request gets the
  current (slightly stale) cache; the next request gets the
  refreshed one. ~zero added latency for the user who tripped the
  refresh.
- **Avalanche jitter** keyed on `state.macMachineId` so multiple
  proxies on different machines don't all refresh at the same wall
  clock minute. Single-user has only one proxy so this is good
  hygiene rather than necessity.
- **Single-flight guard** (`refreshInFlight`) prevents two
  concurrent triggering requests from each firing a refresh. Cheap
  module-level boolean.
- **Failure handling**: if `cacheModels()` throws, log warn and let
  `loaded_at_ms` stay where it was. Next request (or next 5min, if
  we add a short retry-after) tries again. Stale > unavailable.
- **Diff against registry** as part of `cacheModels`: anything
  in the fresh fetch that isn't in the registry emits the L3
  `unknown_protocol_string` warning (or metric, post-observability).

Estimated cost: ~30 LOC + a small test that fast-forwards the clock
via the existing `now` injection on `SingletonCache`.

#### L1b. External fetch + diff (CI, secondary)

Catches changes that happen during long idle periods. Less critical
once L1a is in place.

- **Daily fetch + diff** of `api.anthropic.com/v1/models` and
  `api.openai.com/v1/models` against our registry. Hosted in a CI
  cron (`.github/workflows/audit-models.yml`). On diff, opens an
  issue or PR.
- **Scrape upstream changelogs** weekly: Anthropic's release notes,
  OpenAI's models page, GitHub Copilot changelog. Lightweight
  WebFetch + regex extraction is enough; we don't need NLP.
- **Track `caozhiyuan/copilot-api`** (our upstream fork source) for
  related fixes. The audit run can check for new commits touching
  `models.ts`, anything under `src/services/copilot/`, or anything
  mentioning `web_search` / `web_fetch` would surface relevant
  upstream patches.

Useful in two scenarios L1a doesn't cover:
- Proxy is idle for a week, but you still want an inbox notification
  when a new model lands
- A protocol change shows up in upstream docs/changelog *before* it
  appears in `/v1/models` (e.g. Anthropic announces a new tool
  version with a future activation date)

### Layer 2 — Registry (single source of truth)

Consolidate every protocol literal into one typed table.

- **New file `src/lib/protocol-registry.ts`** with three sub-tables:
  - **Anthropic:** `models[]` (id, family, version, dateStamp,
    capabilities); `toolVersions[]` (name, dated id, latest, also
    supported); `betaHeaders[]` (value, dateStamp, what it enables)
  - **OpenAI:** `models[]`, `toolVersions[]`, `apiVersions[]`
  - **Copilot:** `endpointMappings[]` (model → endpoint family),
    `supportedEndpoints[]`
- **Each entry carries `seenAt`** (when we first saw it) and
  optional `supersededBy`. This is the diff target for layer 1.
- **Replace the 5 regex patterns in `models.ts`** with a single
  `parseModelId(input): ParsedModel` and `formatModelId(parsed,
  style)` that consult the registry. New models add a row, not a
  regex.
- **Replace hardcoded `TOOL_TYPE` strings in `web-tools-vocab.ts`**
  with reads from the registry. The rewriter accepts any version in
  the `supported` list; emits `latest` to upstream when it
  synthesizes blocks.

### Layer 3 — Validation (request time)

Fail loudly — but recoverably — when something doesn't match.

- **At request time**, walk the payload's `tools[]`, `model`, and
  any `anthropic-beta` header through the registry. Anything
  unrecognized produces a structured warning log: `unknown protocol
  string: kind=tool_type value=web_search_20260209 source=request`.
  The request still proceeds (forward-compat hedge) — the strategy
  isn't to block users, it's to know when something needs adding.
- **The zod-validation work from M2 already** validates the on-disk
  config; this extends the same pattern to the request payload —
  but only as warnings, not failures. A bad model ID doesn't crash
  the proxy; it logs and tries.
- **Emit observability metric** `unknown_protocol_string_total{kind,
  value}` so the (deferred) observability dashboard surfaces these
  in real time. Pre-observability: the daily log is the channel;
  the audit script (layer 4) reads from it.

### Layer 4 — Capture (real traffic)

Learn what's actually coming through the wire.

- **Weekly ETL job**: `scripts/audit-protocol.ts` parses the daily
  log, extracts every distinct (model_id, tool_type, beta_header)
  triple, diffs against the registry. Anything new is a candidate
  for promotion.
- **Surface format**: writes
  `docs/observed-protocols-<date>.md` with the diff. Manual review
  by the maintainer; no automated promotion.
- **Once observability lands** (deferred PRD): replace the ETL with
  a SigNoz query — the metric from layer 3 is the same data, served
  faster.

### Layer 5 — Test (pin behavior)

Make the registry the test surface.

- **Test fixtures keyed by registry entries.** Adding a model row
  means adding a test that asserts `parseModelId` works for all its
  formats (dot, dash, dash-date), `formatModelId` round-trips, and
  the appropriate handler routes correctly.
- **Schema tests for tool versions:** when a new `web_search_*`
  version lands, the rewriter test asserts that an incoming request
  with the new version is recognized, the old version still works,
  and the synthesized result block emits the expected shape.
- **Snapshot test** of the full registry — pin the protocol surface
  so an unintended deletion of an entry is caught. Update via
  intentional regen.

## Specific challenges and how the layers solve them

| Challenge | Solved by |
|---|---|
| Model ID normalization regex sprawl | L2 (registry) + L5 (parser tests) — replace 5 regexes with one parser consulting the registry |
| Tool version dating (`web_search_20250305` → `_20260209`) | L2 (registry has `supported` + `latest`) + L3 (validate, log unknowns) |
| Beta header opacity | L2 (registry knows known values) + L3 (log unknown values, pass through unchanged) |
| Variant routing (`-1m`, `-high`, `-xhigh` from `effort` / `longContext`) | L2 (registry encodes the routing table) — one source of truth replaces scattered conditionals |
| OpenAI Responses API drift | L1 (audit upstream) + L4 (capture from real Codex traffic) |
| `claude-opus-4-6-20260301` ↔ `claude-opus-4.6` rewriting for Claude Desktop | L2 (registry has the alias map) + L5 (round-trip tests) |
| Copilot `/models` listing changes | L1 (daily diff against our registry) + L3 (warn-on-unrecognized) |
| New `anthropic-beta` value enabling a feature we don't pass through | L4 (we'd see it in real traffic) + L1 (changelog scrape) |

## Concrete deliverables (when scheduled)

| Deliverable | LOC | Notes |
|---|---|---|
| `src/lib/protocol-registry.ts` | ~400 | The three sub-tables. Adding a model is a one-line edit. |
| `src/lib/parse-model-id.ts` | ~80 | Replaces the 5 regexes in `models.ts`. |
| `src/routes/messages/web-tools-vocab.ts` refactor | net 0 | Reads from registry instead of hardcoding. |
| Validation hook in `handler.ts` | ~40 | Walk payload, emit `unknown_protocol_string` warnings. |
| **L1a lazy refresh middleware** in `src/lib/refresh-models.ts` + Hono middleware | ~30 | Activity-driven `cacheModels()` re-trigger when `loaded_at_ms` is older than 6h ± jitter. Single-flight guard. |
| L1a refresh test (clock-injected `SingletonCache`) | ~50 | Asserts staleness check, single-flight, jitter bounds, failure-keeps-stale. |
| `scripts/audit-models.ts` (L1b) | ~150 | Daily fetch + diff for the idle-proxy case. |
| `.github/workflows/audit-models.yml` (L1b) | ~40 | Cron job that opens an issue on diff. |
| `scripts/audit-protocol.ts` (L4) | ~120 | Log ETL → observed-protocols report. Replaceable by SigNoz query once observability lands. |
| Tests: registry, parser, validation | ~300 | Snapshot of the registry, round-trip parser tests, validation behavior. |
| `docs/admin/protocol-updates.md` | ~80 | Maintainer playbook: how to add a model, how to read the audit reports, how to tune the refresh interval. |

Total: ~1,290 LOC, ~3 days when scheduled. The L1a refresh is an
~80-LOC slice that can ship independently of the rest — useful even
without the registry, since it gets `state.models` actually fresh
within 6h of activity.

## What this strategy is *not*

- **Not automatic registry updates.** L1 detects diffs; a human
  reviews and edits. Auto-merging upstream model rows is a recipe
  for shipping unvalidated routing changes.
- **Not blocking on unknowns.** L3 warns and passes through. The
  proxy stays usable when something new shows up; the
  warning-then-fix loop is short.
- **Not a replacement for the existing upstream-merge cadence.** We
  still pull from `caozhiyuan/copilot-api` periodically. The
  strategy makes the merges easier (registry-shaped diffs) but
  doesn't replace them.
- **Not a substitute for the observability PRD.** L3's metric and
  L4's ETL get more useful when the observability stack lands.
  Until then, the daily log is the data source.

## Pre-requisites and dependencies

- **None hard.** The strategy works on today's singleton-state
  proxy.
- **Soft dep on observability PRD** (`docs/spec/observability.md`):
  L3's `unknown_protocol_string_total` metric is most valuable when
  there's a dashboard reading it. Pre-observability, it's a log
  line.
- **Coordinates with the deferred `RuntimeContext` refactor**: the
  registry is naturally a context-scoped value once that lands
  (different requests could see different supported-protocol sets).
  Today it's a module-level constant.

## Triggers to schedule

This strategy is deliberately not scheduled. Pick it up when one of:

- A user-reported regression traces back to "we didn't recognize a
  new protocol string" (this is the canonical trigger — keeping
  current is reactive otherwise)
- A new Anthropic web-tool version (`web_search_20260209` or later)
  ships and requires a hand-rewrite
- The `claude-opus-4-7` / `gpt-5.6` / similar release lands and the
  current regex parser fails for it
- Multiple beta headers stack up unrecognized in the daily log
  (audit them quarterly even without scheduling)
- The deferred observability PRD lands — at that point L3's metric
  becomes valuable enough that scheduling this strategy follows
  naturally

Until one fires: continue the current reactive pattern. The cost of
a single hand-fix is hours; the cost of building the strategy is
days. The break-even point is "we hit this twice in one quarter."

## Risks

- **Registry maintenance burden.** Adding a new entry has to be
  cheap (one-line edit) or the system collapses under upkeep. L5's
  test surface should require no manual schema work for a new row;
  fixtures are derived from the registry, not parallel to it.
- **L1 false positives.** Anthropic publishes pre-release model IDs
  that aren't user-visible (`-internal`, `-experimental`). Audit
  must flag, not auto-add. Mitigation: L4 (real traffic) is the
  authoritative signal — only promote when both L1 and L4 agree.
- **OpenAI surface drift owned by upstream.** Most of the OpenAI
  protocol-string handling lives in `caozhiyuan/copilot-api` and
  flows through merges. Risk of registry drifting from upstream.
  Mitigation: L1's upstream-fork check is non-optional; the audit
  is what makes the merges manageable.
- **Beta header semantics.** Knowing a header name isn't the same
  as knowing what it enables. The registry should not pretend to
  understand the semantic of every beta header — it tracks
  *existence*, not *meaning*. Documentation lives in the upstream
  changelog, not in the registry.
- **Pre-existing regex behavior.** The 5-regex parser may have
  quirks that real traffic depends on. Replacing it requires
  capturing the existing behavior as tests first, then refactoring,
  then deleting the regexes. Don't skip the capture step.

## Success criteria

When scheduled, the milestone delivers if:

1. Adding a new model is a single registry-row PR — no editing of
   `models.ts`, `web-tools-vocab.ts`, or any handler.
2. Adding a new tool version (e.g. `web_search_20260209`) updates
   one row and a test; the rewriter accepts both old and new
   without code changes.
3. **A proxy that ran continuously for >6h reflects a fresh
   upstream model list within one request after the staleness
   window passes.** No timer, no daemon — the SingletonCache's
   `loaded_at_ms` plus a request-time check is sufficient.
4. The audit cron has run for one week with at least one diff
   surfaced; reviewing the diff and merging is under 10 minutes
   maintainer time.
5. A user reports an unrecognized model ID and the diagnostic path
   is `audit log → registry diff → one-line PR → ship` — under an
   hour from report to fix.

## Out of scope (this strategy)

- The observability stack itself — `docs/spec/observability.md`
- The web-tools agent loop — `docs/spec/web-tools.md`
- The state/config/cache cleanup — `docs/spec/state-config-cache-cleanup.md` (closed)
- MDM / Cowork egress — `docs/admin/claude-desktop-mdm.md`
- Provider expansion (new inference backends beyond Copilot) —
  separate effort; the registry pattern from L2 is the natural
  extension point if a third provider lands.

## References

Code surface to consolidate:

- `src/lib/models.ts:45-71` — five-pattern Claude ID parser (parallel
  to the rewrite layer; not actually called from rewriting today)
- `src/lib/anthropic-id-rewrite.ts` — the actual rewrite layer:
  `forwardId` (line 31), `reverseId` (line 51), `isVariantId` (line
  69), `pickCopilotVariantId` (line 84). Hardcodes `SENTINEL_DATE =
  "20260301"` (line 15), the family list (`opus|sonnet|haiku`), and
  the variant suffix regex (`low|medium|high|xhigh|max|1m` optional
  `-internal`)
- `src/routes/messages/web-tools-vocab.ts:9-12` — hardcoded
  `web_search_20250305`, `web_fetch_20250910`
- `src/services/copilot/get-models.ts` — the fetch
- `src/lib/utils.ts:23 cacheModels()` — the filter + cache step
- `src/routes/models/route.ts` — the outbound listing transform
- `src/lib/api-config.ts:156 copilotBaseUrl()` — five-branch base-URL
  selection (account type, enterprise, opencode-OAuth, override,
  default)

Files referencing protocol literals today (9):
`anthropic-id-rewrite.ts`, `web-tools-types.ts`,
`count-tokens-handler.ts`, `responses/handler.ts`,
`web-tools-rewriter.ts`, `web-tools-vocab.ts`, `messages/handler.ts`,
`services/copilot/create-messages.ts`,
`services/providers/anthropic-proxy.ts`.

Upstream model-list sources (L1 detection targets):

- Anthropic: https://docs.anthropic.com/en/api/models-list
- OpenAI: https://platform.openai.com/docs/models
- Copilot: our existing `getModels()` (single source per fetch)
