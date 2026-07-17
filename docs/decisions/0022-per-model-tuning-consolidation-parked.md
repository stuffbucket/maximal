---
id: ADR-0022
title: Per-model tuning consolidation (#336) parked — ModelProfile arc status
status: accepted
date: 2026-07-17
authors:
  - stuffbucket
supersedes: []
related_adrs:
  - docs/decisions/0016-copilot-provider-coupling-and-api-divergence.md
  - docs/decisions/0010-effective-config-read-api.md
links:
  capability_resolver: src/lib/models/model-profile.ts
  config: src/lib/config/config.ts
  config_schema: src/lib/config/config-schema.ts
  parked_branch: "https://github.com/stuffbucket/maximal/tree/feat/config-models-record"
  parked_pr: "https://github.com/stuffbucket/maximal/pull/344"
  landed_pr: "https://github.com/stuffbucket/maximal/pull/364"
parked_commit: 37bbe8db2b1eb912f9b50855fc2720c770610e20
---

# Per-model tuning consolidation (#336) parked — ModelProfile arc status

## Context

`ModelProfile` (`src/lib/models/model-profile.ts`) is a three-part arc that
replaces per-model `if (model.id === "…")` branches scattered across the
transform sites with one resolved record branched on DATA, not identity:

| Step | Scope | Status |
|---|---|---|
| **#341** — widen the resolver | INTRINSIC, catalog-derived capability facts (reasoning, adaptive-thinking, effort ladder, thinking budgets, tool-calls, structured-outputs, token limits) + migrate the capability-bypass sites to read them | **Landed on main** via PR #364 (`ea9ca58`). |
| **#336** — consolidate authored tuning | The AUTHORED half: collapse the three parallel id-keyed config maps into one per-model record | **Parked** — this ADR. Implementation preserved; not on main. |
| **#338** — merge tuning into the profile | Fold the resolved authored tuning into `ModelProfile` so one record is the whole truth about a model | **Not started / not scoped.** |

The resolver's own scope comment names this split: it holds intrinsic facts
only, while "authored per-model tuning … is being consolidated separately
(#336); once that lands, the resolved tuning merges in here too, completing
the ModelProfile picture (#338)." #364 landed #341 but deliberately left the
config-tuning side (`config.ts`) untouched. This ADR records the disposition
of #336 so its state stops being re-derived (and so the work is not lost to a
closed PR + a stale branch).

### What #336 is

Commit `37bbe8d` ("refactor(config): consolidate per-model tuning into one
models record"), on branch **`feat/config-models-record`** (preserved on the
remote), closed **PR #344**. It collapses the three parallel id-keyed maps —
`extraPrompts`, `modelReasoningEfforts`, `responsesApiContextManagementModels`
— into a single `models: Record<id, ModelTuning>`, so onboarding a model is
ONE keyed entry rather than three edits that can drift out of alignment (the
exact drift that hid the GPT-5.6 trio). `smallModel` stays a separate scalar
selector. Shape of the change:

- `config.ts`: a `ModelTuning` interface; a `models` field replacing the three
  maps; `defaultConfig` collapsed to one `models` block; accessors +
  `mergeDefaultConfig` rewritten (whole-model back-fill, matching prior
  `Object.hasOwn` semantics); `getResponsesApiContextManagementModels` dropped
  (unused externally).
- `config-schema.ts`: a `ModelTuningSchema`; the three legacy keys removed from
  the shape (an un-migrated legacy key then reads as unknown); `models` added;
  still `.loose()`.
- `migrateLegacyModelTuning`: a reader-side shim that runs BEFORE validation,
  folds the legacy maps into `models`, and DELETES the legacy keys (so `.loose()`
  passthrough doesn't retain both shapes).

## Decision

**Park #336. Do not merge the `feat/config-models-record` branch as-is; do not
delete it.** Its implementation is the record of the design and is preserved on
the remote branch (`37bbe8d`) and closed PR #344, referenced from this ADR.
main keeps the three legacy config maps until the arc is scheduled.

### Why parked rather than landed now

- **It is a design event, not a merge.** #336 rewrites the on-disk config
  shape and ships a legacy-config MIGRATION shim (`migrateLegacyModelTuning`).
  That touches every existing user's `config.json` on first read — the class of
  change that warrants deliberate scheduling and a migration-safety review, not
  a cleanup-window merge. This is the same read-path config surface ADR-0010
  governs.
- **The arc is only half-built.** #336 is the middle step; its payoff is #338
  (merging the resolved tuning into `ModelProfile`), which is not scoped. Landing
  #336 alone adds a new config schema + migration without the consumer that
  motivates it.
- **The branch is stale.** It sits well behind main (it predates the
  single-window redesign, the boundary-hardening, and #364 itself) and re-conflicts
  on `config.ts` — the same file whose reasoning-effort policy #364's reconciliation
  already deferred to main's shipped defaults. Reviving it is a re-implementation
  on current main, not a rebase.

### Consequences

- main continues to use `extraPrompts` / `modelReasoningEfforts` /
  `responsesApiContextManagementModels` as three separate maps. Onboarding a
  model remains a three-map edit until #336/#338 are scheduled — a known,
  accepted cost, not a gap.
- The `feat/config-models-record` branch is retained as the design record. Do
  not prune it while this ADR is `accepted`.
- PR #344 stays closed; a comment on it points here so it is not a dead end.

## Triggers to resume

Pick up #336 (as a FRESH PR re-implementing the consolidation on current main —
cleaner than rebasing the stale branch) when one of:

- #338 is scheduled — the consumer that makes the consolidated `models` record
  worth its migration cost.
- A model-onboarding change again drifts because a model was added to one of the
  three maps but not the others (the #336 motivation recurs).
- The config schema is being revised for another reason and folding the three
  maps in becomes incremental rather than standalone.

Until one fires, the three-map shape stands. Re-read this ADR before
re-assessing; do not re-derive the consolidation design — it exists at `37bbe8d`.

## Sources

- Parked implementation: branch `feat/config-models-record`, commit `37bbe8d`,
  closed PR #344.
- Landed sibling: PR #364 (`ea9ca58`) — the #341 resolver widening + capability-site
  migration.
- Resolver scope + the #336/#338 breadcrumbs: `src/lib/models/model-profile.ts`.
- Config read-path this touches: ADR-0010 (effective-config read API).
