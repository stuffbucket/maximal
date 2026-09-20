# Project Health Audit — maximal

**Status:** Findings report for review. Read-only audit — no code changed.
**Date:** 2026-07-04.
**Method:** Four parallel read-only audits over `src/` (155 files, ~25k LOC),
partitioned by subsystem plus one signature-level lens. Every finding carries
`file:line` evidence; the highest-stakes items were independently re-verified
against the code before inclusion (noted ✓).

## How to read this

Findings are bucketed by **type**, not by agent, and ranked within each bucket
by attention-worth. Three buckets:

- **A. Genuine defects** — behavior is wrong or a secret is over-exposed. Fix on
  their own merits, ahead of structural work.
- **B. Structural debt** — duplication, coupling, and cohesion problems that
  raise the cost and risk of every future change. This is the bulk of the audit
  and the answer to "where should we pay more attention."
- **C. Dead / low-value / vestigial** — code that no longer earns its place.

Cross-agent corroboration is called out explicitly — a finding two independent
audits reached from different angles is a stronger signal than either alone.

---

## A. Genuine defects (fix first)

### A1. `maximal app claude-code --enable` never persists routing intent — boot self-heal silently no-ops ✓
`src/apps/claude-code/index.ts` `enable()` writes `settings.json` but never sets
`config.apps.claudeCode.enabled`. That flag is written in exactly **one** place —
`src/routes/settings/apps.ts:49,127` (the HTTP/UI path). Boot & shutdown
reconciliation gate on it (`src/apps/claude-code/reconcile.ts:12`
`claudeCodeRoutingIntended()` → `enabled === true`). So a user who runs the
**documented CLI command** gets settings written now, but the execPath self-heal
(the entire reason `reconcile` exists) never runs for them — a moved or updated
binary quietly breaks their integration, and shutdown never strips the base URL.
**The UI and CLI produce divergent durable state for the same operation.**
Verified: the flag write exists only in the HTTP path. *(audit-apps)*

### A2. `/token` returns the raw upstream token and is not loopback-gated ✓
`src/routes/token/route.ts:9` returns `{ token: state.copilotToken }` — the
actual secret. `server.ts:70-78` `loopbackOnlyPaths` lists `/usage`,
`/token-usage`, `/token-usage/events`, `/_internal/shutdown` — **not `/token`**.
Every *other* token-adjacent read is deliberately presence-only (accounts route,
`/status`, diagnostics all return booleans). `/token` is the lone endpoint
handing back the credential, guarded only by the API-key gate, not the stricter
loopback gate its risk profile warrants. Confirm it's still needed; if so, add it
to `loopbackOnlyPaths`. *(audit-apps)*

### A3. Duplicated security-sensitive atomic-write, symlink guard in only one copy
`atomicWriteJson` (`src/apps/claude-desktop/config.ts:119`) and
`writeClaudeCodeSettings` (`src/apps/claude-code/config.ts:223`) are near-identical
(mkdir, stale-`.tmp` unlink, `O_EXCL @0o600`, write+fsync+rename) — **but the
claude-code copy has an `EEXIST` symlink-attack guard (`config.ts:245-251`) the
desktop copy lacks.** Exactly the drift two copies of security code invite.
Consolidate to one `~/lib/atomic-json`. *(audit-apps)*

> Note: A1/A2 are correctness/security, not aesthetics. A3 is a latent hardening
> gap. These three should be filed and fixed independently of the structural work.

---

## B. Structural debt (where to pay attention)

### B1. The `create*` upstream API family — divergent signatures + triplicated request logic *(corroborated: audit-core + audit-signatures)*
The four Copilot-call entry points diverge arbitrarily where they should share a
shape (`services/copilot/`):
```
create-chat-completions.ts:23  createChatCompletions(payload, options: {subagentMarker?,requestId,sessionId?,compactType?})
create-messages.ts:71          createMessages(payload, anthropicBetaHeader, options: {…same inline object…})
create-responses.ts:387        createResponses(payload, {vision,initiator,subagentMarker,requestId,sessionId,compactType}: ResponsesRequestOptions)
create-embeddings.ts:5         createEmbeddings(payload)
```
Three option-passing conventions; `createMessages` also hoists a positional
`anthropicBetaHeader`; return types split (two named, two inferred). **And the
"agent vs user initiator" detection — which drives `x-initiator` and therefore
credit consumption — is re-derived three subtly different ways**
(`create-chat-completions.ts:43`, `create-messages.ts:94` (inverted,
tool_result-aware), `responses/utils.ts:18` (missing-role⇒agent)). This is the
single highest-value dedup: one `isAgentTurn(lastMessage)` + one
`CopilotCallOptions` base. It's a billing-correctness surface, not just tidiness.
*(audit-core §8, audit-signatures §1)*

### B2. `preprocess.ts` (640L) — 8 unrelated request-mutation jobs, home of the #210 thinking-inversion
One file owns top-level strip, compact detect, a ~330L tool_result/attachment
merge, IDE sanitize, cache_control strip, thinking filter, sampling strip, and
the adaptive-thinking rewrite (`preprocess.ts:41–640`). High churn (6 changes/6mo),
highest blast radius in the codebase. `prepareMessagesApiPayload` reads
`incomingDisplay`/`clientDisabledThinking` *before* overwriting `payload.thinking`
(`:600-623`) — a subtle ordering contract one edit from regressing (it already
regressed once, as #210). Splitting this into a pipeline of named,
independently-testable passes is the highest-leverage structural change for
reliability. *(audit-core §2)*

### B3. `handleCompletion` mutates `payload.model` four times — untraceable routing key
`src/routes/messages/handler.ts:58,87,113` reassign `payload.model` in place on
one path, order-dependent, and the warmup heuristic (`:86-88`,
`anthropicBeta && noTools && compactType===0`) **silently overrides an explicit
model**. Classic surprise-bug site; routing decisions should be a derived value,
not repeated in-place mutation. *(audit-core §1)*

### B4. Two parallel stream state machines, incompatible models, fixes don't cross
`stream-translation.ts` (376L, scalar index + bool + map) and
`responses-stream-translation.ts` (743L, 4 Maps/Sets) reimplement the same
block-open/close-before-open lifecycle. A whitespace-runaway guard added to one
(`responses-stream :35-59`) has **no analogue in the other**. The event-vs-delta
difference is load-bearing, but the block-lifecycle cursor is duplicated — a
shared `BlockCursor` collapses the shared half. *(audit-core §4)*

### B5. `global state` read/written by 40+ modules; the same predicates re-derived at 4 sites *(corroborated: audit-lib + earlier debug-overlap audit)*
`state.ts:72` exports one mutable object imported by 40+ modules; token fields are
assigned from **6** modules with no owner. The "authenticated/ready" predicate is
re-derived identically at `status.ts:74`, `settings/api.ts:65`, `debug/route.ts:49`;
`state.models?.data.length ?? 0` at three sites. A `tokenPresence()` /
`modelsCached()` accessor (and a single owner for the token trio) collapses all
of it. This is the coupling backbone under many other findings. *(audit-lib §2)*

### B6. `debug` reads credential presence from DISK; every HTTP surface reads in-memory `state` *(corroborated: audit-lib + debug-overlap)*
`src/debug.ts:90-95` answers "active account?" from disk (`readDefaultRecord`),
while `/status`, `/_debug/state`, and `/settings/api/diagnostics` answer from
in-memory `state.githubToken`. After `markSignedOut()` clears memory but
intentionally retains the disk record, **`maximal debug` says "account present"
while `/status` says "unauthenticated"** — a real source of contradictory bug
reports. Reconcile, or document the split at each site. *(audit-lib §3)*

### B7. `src/lib` is a flat 58-file dumping ground
58 top-level modules spanning ~10 concerns, only 3 subdirs. The auth subsystem
(auth-controller/token/auth-recovery/github-token-store/request-auth/secrets/…)
is invisible as a unit; the tree stops working as a navigation aid; it hides that
`state.ts` is a 40-importer hub (B5). A concrete re-grouping was proposed —
`auth/`, `http/`, `config/`, `models/`, `errors/`, `runtime-state/`, `platform/`,
`update/` — leaving `start/`, `system/`, `token-usage/` as-is. Mechanical, high
readability payoff. *(audit-lib §1)*

### B8. `token.ts` ↔ `auth-controller.ts` — duplicated sign-in orchestration + circular dep
Two device-code sign-in paths (legacy blocking `setupGitHubToken` vs non-blocking
`startDeviceFlow`) each write the "resolve login → build record → persist → mint
Copilot → cache models" sequence, with **divergent failure handling**
(`token.ts:384` persists under "unknown"; `auth-controller.ts:462` drops the
token). A genuine module cycle exists (`token.ts:14` ↔ `auth-controller.ts:60`),
working only via function-level refs. *(audit-lib §4)*

### B9. `web-tools/stream.ts` (493L) double-translates and drops the model's real endpoint
Per agent turn: Anthropic→OpenAI → upstream → translate-back → **re-parse those
events back into assistant content** to build the next turn (full round-trip ×2).
And the loop always uses `translateToOpenAI`, so declaring `web_search`/`web_fetch`
silently downgrades a Claude or GPT model to chat-completions — an undocumented
fidelity loss. Thinking blocks are dropped across turns (`stream.ts:430`). Hardest
control flow in the codebase. *(audit-core §5)*

### B10. Smaller duplications with a single clear fix each
- **`THINKING_TEXT` defined twice** (`non-stream-translation.ts:31`,
  `responses-translation.ts:56`); `isNonStreaming`/`isAsyncIterable` each defined
  twice — one shared module removes silent drift. *(audit-core §8)*
- **`safeParse→500` envelope copy-pasted 4×** (`apps.ts:31,87`, `api.ts:98`,
  `models.ts:89`) → one `respondValidated(c, Schema, payload)`. *(audit-apps §7)*
- **Three inconsistent error idioms** across structurally-identical small routes:
  `/settings/api/*` use `forwardError`; `token/route.ts:11`, `usage/route.ts:11`
  use bare `console.error`; `token-usage`/`setup-status` have no try/catch.
  *(audit-apps §8)*
- **Three near-identical `__set*DepsForTests` DI-shim blocks** with the same
  comment copy-pasted (`auth-controller.ts:73`, `token.ts:50`,
  `auth-recovery.ts:54`) → one `createTestSeam`. *(audit-lib §5, audit-signatures §5)*
- **Streaming-SSE scaffold triplicated** in `api-flows.ts:114,192,325` (drift
  already present — responses path records usage twice). *(audit-core §7)*

### B11. Signature-level consistency smells *(audit-signatures)*
- Two exported `handleCompletion` with identical signatures for different
  endpoints (`routes/messages/handler.ts:51`, `chat-completions/handler.ts:26`) —
  rename `handleMessages`/`handleChatCompletions`.
- Two `translate*` naming schemes (terse `translateToOpenAI` vs verbose
  `translateAnthropicMessagesToResponsesPayload`) — unify.
- `export function` vs `export const = () =>` used interchangeably for peers (no
  enforced convention; lintable).
- Effectful `Promise<void>` mutators under-report what they do — `markAuthDegraded`
  (`auth-controller.ts:665`) reads as a setter but clears tokens and kicks a
  recovery sweep; not even declared `async`.
- Positional booleans at call sites: `prepareInteractionHeaders(sessionId,
  Boolean(subagentMarker), headers)` (`api-config.ts:113`, also mutates arg 3),
  `copilotHeaders(state, requestId, true)` (`:232`).

### Cross-file undocumented contract (watch)
The `@`-in-signature ⇒ "GPT/responses, not Claude" convention is silently shared
across `responses-translation.ts:396`, `non-stream-translation.ts:184`,
`preprocess.ts:556` — untyped, undocumented, three-file coupling. *(audit-core §3)*

---

## C. Dead / low-value / vestigial

`knip` runs clean (no unused *exports*) — everything below is field/state-level,
which knip cannot catch (test files count as consumers). Hand-verified:

- **SingletonCache mirror of `state.copilotToken`/`state.models` is write-only** ✓
  (`state.ts:14,82-93`) — values are `.set()` but never `.get()`/`.has()`; only a
  derived `loaded_at_ms` metric is read. The class's get/has/clear are dead for
  this use, and the header comment claiming it "holds" the state is misleading.
  *(audit-lib §6)*
- **`makeRecord` + `writeGitHubTokenRecord`** (`github-token-store.ts:122`) have
  zero production callers (tests only); the `refreshToken` field (`:32`) is written
  `null` everywhere, read nowhere. *(audit-lib §7)*
- **Unused params:** `translateAnthropicMessagesToOpenAI(_,_,_thinkingBudget)`
  computes+passes a 3rd arg never used (`non-stream-translation.ts:44`);
  `resolveAssistantPhase(_model,…)` (`responses-translation.ts:308`);
  `buildAnthropicBetaHeader(_model)` with a no-op "dedup" comment
  (`create-messages.ts:40`). *(audit-core §10)*
- **Vestigial config:** `editorVersion` (`config.ts:57`, only spoofs a header),
  `useFunctionApplyPatch` (`config.ts:36`, single consumer). `auth.apiKeys` (legacy)
  vs `auth.apiKeyEntries` coexist permanently. *(audit-lib §8)*
- **Intentionally retained (NOT dead):** `--apiKeyHelper` legacy alias
  (`main.ts:43`, still self-heals old on-disk configs) and the `copilot-cli`
  coming-soon stub — flagged only because they *look* vestigial. *(audit-apps §9)*

---

## What reads well (so we don't regress it)

The audit found genuinely clean areas worth using as the pattern to copy:
- `github-token-store.ts:214+` — pure `(reg, …) => reg` mutator family; the whole
  account state model is readable from signatures alone. *(audit-signatures)*
- `web-tools/state.ts` policy checks + `executor.ts` `pickResponsesModel`/
  `resolveResponsesModel` — textbook pure-core/policy split. *(audit-signatures)*
- `token-usage/index.ts:152` `createTokenUsageRecorder` — the right way to do what
  the `create*` family (B1) does wrong.
- `apps/` and `web-tools/` overall — deliberate pure-core + thin-wrapper discipline.
- App-config edits are ownership-guarded with atomic writes; route contracts are
  schema-validated. The codebase is disciplined; these findings are about where
  that discipline is *unevenly* applied.

---

## Recommended sequencing

1. **File and fix the three defects (A1–A3) first** — correctness + security, each
   small and self-contained.
2. **B1 (create\* family / initiator dedup)** and **B5 (state predicates + owner)**
   next — highest-value structural dedup, both touch billing/auth correctness.
3. **B2 (`preprocess.ts` split)** and **B7 (`lib/` re-grouping)** as focused
   refactors — biggest readability/reliability payoff, larger effort.
4. **B10 quick dedups** — cheap, reduce drift immediately.
5. Everything else as capacity allows; the "reads well" list is the target shape.
