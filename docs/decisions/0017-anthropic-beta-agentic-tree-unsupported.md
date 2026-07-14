---
id: ADR-0017
title: Anthropic beta agentic tree (/v1/dreams and siblings) intentionally unsupported
status: accepted
date: 2026-07-14
authors:
  - stuffbucket
supersedes: []
related_adrs:
  - docs/decisions/0016-copilot-provider-coupling-and-api-divergence.md
links:
  routing: src/server.ts
  messages_handler: src/routes/messages/handler.ts
  drift_baseline: scripts/ops/external-drift-baseline.json
  investigation_issue: "https://github.com/stuffbucket/maximal/issues/319"
  drift_pr: "https://github.com/stuffbucket/maximal/pull/316"
beta_gate: "anthropic-beta: dreaming-2026-04-21"
---

# Anthropic beta agentic tree (/v1/dreams and siblings) intentionally unsupported

## Context

PR #316 bumped `anthropicSdkStatsSha` in
`scripts/ops/external-drift-baseline.json` to reconcile an upstream
`/v1/messages` OpenAPI-spec drift flagged by the external-surface drift
watcher. No schema the proxy currently models (`CreateMessageParams`,
`Message`, `MessageStreamEvent`, `ContentBlock`, …) changed — #316 is a
safe baseline bump. But the spec's net-new surface (`configured_endpoints`
116 → 121) is a new Anthropic **beta** resource tree, and the #316 review
asked whether the proxy can or should mirror it. Issue #319 recorded that
investigation; this ADR records its disposition so it stops being
re-derived each time the tree grows.

### The surface

`client.beta.dreams.*`, gated by `anthropic-beta: dreaming-2026-04-21`.
Five endpoints, all `?beta=true`:

| Method | Path | SDK method | Returns |
|---|---|---|---|
| POST | `/v1/dreams` | `create` | `BetaDream` |
| GET | `/v1/dreams/{dream_id}` | `retrieve` | `BetaDream` |
| GET | `/v1/dreams` | `list` | `BetaDreamsPageCursor` |
| POST | `/v1/dreams/{dream_id}/archive` | `archive` | `BetaDream` |
| POST | `/v1/dreams/{dream_id}/cancel` | `cancel` | `BetaDream` |

`/v1/dreams` is a **stateful, async "dream" job**: create → poll `retrieve`
for `BetaDreamStatus` → `archive`/`cancel`, coupled to memory-stores,
sessions, and a per-dream model config. It is one branch of a large new
Anthropic agentic-platform beta tree under `src/resources/beta/` in
`anthropics/anthropic-sdk-typescript`: **agents, sessions, memory-stores,
deployments, environments, skills, vaults, user-profiles**, and dreams —
of which dreams is the part that surfaced as net-new endpoints in this
spec bump. The rest of the tree carries the same shape.

## Decision

**The Anthropic beta agentic tree — `/v1/dreams` and its siblings — is
intentionally unsupported.** The proxy will not mirror it. Track-and-
document; do not implement. (Issue #319 disposition #1.)

### Why it is not mirrorable

The proxy is a **stateless request translator**. It maps the Anthropic
`/v1/messages` wire contract onto GitHub Copilot completions and nothing
more. Its entire registered surface is enumerated in `src/server.ts`:
`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`, `/v1/responses`,
`/v1/messages`, and the `/:provider/v1/{messages,models}` variants. There
is **no catch-all** — any unregistered `/v1/*` path (including
`/v1/dreams`) passes the `server.use("/v1/*", requireGithubAuth)` auth
gate and then falls through to Hono's default 404.

The agentic tree is a **stateful, async, Anthropic-native** platform:
job lifecycles, memory-stores, sessions, per-job model config,
deployments, environments. **None of our backends** — Copilot
chat/completions, `/responses`, `/models` — expose anything equivalent,
and a dreams job / session / memory-store cannot be synthesized out of
chat completions. Mirroring it would mean standing up a stateful async-job
subsystem **with no backend able to serve it** — outside the remit of an
impersonating translator. This is the same coupling ADR-0016 documents:
the engine speaks *Copilot's* contract, and Copilot has no comparable
capability to translate onto.

### Consequences

- `/v1/dreams` and its siblings return Hono's default 404 (401 first if
  unauthenticated). This is the intended behavior, not a gap.
- The drift watcher will keep flagging growth in this tree as the beta
  expands. Those flags are **expected and safe to dismiss against this
  ADR** as long as they touch only the beta agentic resources and not the
  schemas the proxy models for `/v1/messages`. Re-read this ADR before
  re-investigating; do not re-derive the feasibility assessment.
- Adding support is a **design event, not a feature toggle**: it requires
  a backend with a comparable async-job / session / memory-store
  capability. Revisit only if a backend gains one (issue #319
  disposition #3).

## Optional UX improvement — deferred, not adopted here (issue #319 disposition #2)

Issue #319 floated a small optional improvement: return an informative
`501`/`404` for known-but-unsupported Anthropic beta endpoints instead of
a bare Hono 404. After weighing it against how routing works today, this
ADR **declines to implement it** and records the recommendation for a
human to pick up if desired.

Reasoning:

- **Negligible real-world benefit.** These paths sit behind
  `requireGithubAuth`; a caller without a token gets 401 regardless. The
  proxy never advertises the `dreaming-2026-04-21` beta, so no client the
  proxy fronts (Claude Code, the SDK) routes these calls here in normal
  use. The informative body would almost never be seen.
- **It creates exactly the silent-rot surface ADR-0016 §7 warns against.**
  An explicit 501 requires a hardcoded allowlist of Anthropic beta
  resource names (`dreams`, `agents`, `sessions`, `memory-stores`,
  `deployments`, `environments`, `skills`, `vaults`, `user-profiles`, …)
  that drifts as Anthropic adds resources — a maintenance burden pinned to
  an upstream we do not control.
- **Risk of masking real 404s.** A too-broad `/v1/*` matcher could shadow
  a future legitimate route or convert a genuine typo/mistake into a
  confident, wrong "intentionally unsupported" 501. The current bare 404
  is honest: the path is simply not registered.

If a human decides the explicit UX is worth it, the low-risk shape is a
**narrow, explicit prefix allowlist** (not a `/v1/*` catch-all) returning
a `501 Not Implemented` JSON body citing this ADR — registered *after* all
real routes so it can only ever match paths that would otherwise 404, with
a test asserting it does not shadow any registered route. Absent that
decision, the default 404 stands.

## Sources

- Investigation: issue #319 (feasibility assessment and disposition
  options).
- Drift that surfaced it: PR #316; baseline
  `scripts/ops/external-drift-baseline.json` → `anthropicSdkStatsSha`.
- Anthropic SDK surface: `anthropics/anthropic-sdk-typescript` →
  `api.md` (`## Dreams`) and `src/resources/beta/dreams.ts`.
- Beta gate header: `anthropic-beta: dreaming-2026-04-21`.
- Provider coupling this decision rests on: ADR-0016.
</content>
</invoke>
