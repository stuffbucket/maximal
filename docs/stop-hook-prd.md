# PRD: How we use Claude Code hooks today

Status: **observation + framing** — describes what we see in practice
and how it relates to what Anthropic's hook documentation prescribes.
Intent: give whoever owns the hooks a sharp problem statement before
solutioning.

## What's actually in place today

`.claude/settings.json` registers two hooks. Both end-of-action,
neither pre-action; both veto-capable; both share one JSONL log.

| Hook       | Event       | Matcher              | Script              | Timeout |
| ---------- | ----------- | -------------------- | ------------------- | ------- |
| Edit-check | PostToolUse | `Edit\|Write\|MultiEdit` | `check-on-edit.ts`  | n/a     |
| Stop-check | Stop        | (none)               | `check-on-stop.ts`  | 120s    |

### `check-on-edit.ts` — runs after every file edit

Spawns three jobs **in parallel** on the edited file's project:

- `bunx oxlint <file>` — scoped to the changed file
- `bun run lint <file>` — eslint, scoped
- `bun run typecheck` — **whole-project** tsc (despite the per-file
  trigger)

Filters out `.claude/**`, `node_modules`, `dist`, and non-JS/TS
extensions. Exit 2 + stderr block the tool call's "all good"
signal back to Claude.

### `check-on-stop.ts` — runs at the end of every turn

Three stages, parallel, 90s per-stage timeout:

| Stage    | Command                  | Veto-capable | Notes                       |
| -------- | ------------------------ | ------------ | --------------------------- |
| `test`   | `bun test`               | yes          | full suite                  |
| `knip`   | `bun run knip`           | yes          | repo-wide unused-export scan |
| `design` | `bun run design:check`   | no           | informational only          |

Quoting the hook's own header:

> exit 0 = no veto (turn completes silently)
> exit 2 + stderr = veto (Claude Code surfaces the stderr to the user)
> Any other condition … MUST exit 0 silently.

Layered runner / logger / aggregator separation; catastrophic safety
net (any uncaught exception → log + exit 0). The hook implementation
is sound — the observations below are about *signal patterns*, not
bugs.

### Shared sink — `.claude/logs/checks.jsonl`

Both hooks append one JSONL line per run. The line is consumed by
`scripts/gemma-watch.ts` (`bun run analyze`), a local Ollama meta-
analyzer. The log is the only durable record of hook firings; nothing
else reads it today.

### Implicit curation policy

The hook runs **test + knip + design** at end-of-turn and
**oxlint + eslint + typecheck** at end-of-edit. It does **not** run
`depcruise`, `lint:fast` (full repo), `mutate`, or any of the
narrower `*.test.ts` subsets. The selection criteria for what
deserves to be in a hook vs left as a manual gate
(`check:fast`, `check:deep`) are not written down anywhere.

## Observed behaviors

### 1. Pre-existing failures re-fire indefinitely

Stop has no memory between turns. A failure that was failing when the
session started is failing now and will fail next turn — each firing
is technically correct and identical to the previous one.

Observed sequence in a single session:

- `settings-route` 1e/1f/1g (401 vs 200) fired 3 turns in a row.
- `account-section` "error card uses the error variant" fired 3
  turns in a row.
- Assistant eventually fixed both inline just to silence the hook,
  even though both were ambient and out-of-scope for the in-flight
  task.

### 2. In-flight async work shows as broken state

Stop fires once per assistant turn; background `Agent` tool work
continues *across* turns. When one subagent has landed a helper and
the sibling that consumes it hasn't, the hook fires `knip`
"unused export" on the orphan. Observed three times for
`__resetActiveClientsForTests` while a background agent was still
writing `tests/active-clients.test.ts`. The hook sees a snapshot;
the codebase is mid-edit.

### 3. PostToolUse + Stop double-fire on the same turn

Edit a file → `check-on-edit.ts` fires (whole-project tsc + scoped
lint). The same turn completes → `check-on-stop.ts` fires
(whole-suite test + knip). Two heavy parallel runs back-to-back, with
overlap that's not de-duplicated: both can re-check a file edited
seconds earlier. On a turn with several edits, this stacks.

### 4. Same failure, different formatting per firing

Test names include `bun test`'s per-run timings (`[131.36ms]`,
`[117.62ms]`). Identical underlying failures serialize differently
each turn. There is no stable failure ID an assistant can hash to
recognize "I've seen this one already."

### 5. Hook output dominates assistant context

A single Stop firing for 4 ambient failures was ≈600 tokens. Across
5 turns of the same failures, ≈3,000 tokens of recurring noise —
larger than the underlying conversation it sits inside. The
assistant *also* writes a response acknowledging the hook output
("the 4 failures are pre-existing"), which doubles the cost: hook
output + assistant explanation.

### 6. The hook can't see filesystem / git state mutations

Sequence observed in this repo:

1. Backend subagent ran `git stash pop` to "verify pre-existing test
   state."
2. The pop hit a conflict and left React-shell files inconsistent.
3. Subagent ran `rm` on the unfamiliar files to "revert unrelated
   state" — wiping a sibling agent's untracked work.
4. The main session didn't notice for two more turns. The hook
   reports `bun test` + `knip` only; it has no view of "files
   deleted" or "git state mutated."
5. Damage surfaced only when the main assistant later ran `tsc`.

The hook is blind to the entire class where the source-of-truth
filesystem mutates silently between turns.

### 7. Broader blind spots in what the hook reports

What `Stop` + `PostToolUse` *do not* see:

- Branch switches, stash ops, uncommitted reverts, untracked-file
  deletes (observation 6 above).
- Sidecar / proxy process state — a crashed `:4142` sidecar between
  turns leaves no signal.
- Config / secret rotation — `~/.local/share/copilot-api/config.json`
  could be edited externally with the assistant unaware.
- External long-runners — a `bun run mutate` started earlier finishes
  in the background; nothing surfaces the result.
- Port binding, network reachability, OS notification permissions,
  Tauri dev-server liveness.

### 8. Hook can't distinguish "novel" from "ambient" failure

There's no diff against a baseline. Every reported failure reads as
"the assistant's fault on this turn," including ambient failures
and those introduced by sibling subagents. The assistant has to
re-derive that attribution by hand on every firing.

### 9. `knip` "Configuration hints" are unactionable padding

Each firing prints 13 "Remove from ignoreDependencies /
ignoreBinaries" hints that have been hinted for weeks. They are
visual noise in every firing and crowd out the actionable lines.

### 10. The analyze sink exists but no one consumes it interactively

`.claude/logs/checks.jsonl` is the one durable record. `gemma-watch`
exists. In practice no one runs `bun run analyze` during work — the
log accumulates and the realtime channel is the only one the
assistant sees. There's a meta-signal layer designed in but the
loop isn't closed.

## How this relates to Anthropic's documented model

Anthropic publishes 29 hook event types and ships **no dedicated
"hook best practices" page**; guidance is embedded inline in the
hooks reference. What the docs *do* say is relevant:

- **`Stop` semantics.** Exit 2 + stderr blocks the Stop action and
  surfaces output. Our hook honors this correctly. The friction
  comes from "the hook is doing exactly what it's designed to do,
  repeatedly."
- **`PostToolUse` is intended to be fast.** Anthropic's perf guidance
  flags hooks that fire on every tool call. Our `check-on-edit`
  runs a whole-project tsc per edited file — likely the slowest
  thing in the loop. Tsc is the right check; *per-edit* may be the
  wrong cadence.
- **Subagent hook story.** `Stop` auto-converts to `SubagentStop` for
  subagents. `SessionStart` fires for every agent. Skill / agent
  *frontmatter hooks* run while that skill or agent is active —
  Anthropic's documented mechanism for injecting rules into spawned
  subagents. **We are not using this mechanism**; we string-paste
  rules into agent prompts at fan-out, which is forgettable and
  scales linearly with fan-out sites.
- **`hookSpecificOutput.additionalContext`**. Anthropic explicitly
  positions this for *environment state, conditional rules, external
  data* — and **not** for static rules (those belong in `CLAUDE.md`)
  and **not** for imperative instructions. We're not using it.
- **Events we're not using that map onto observed problems.**
  - `SubagentStart` / `SubagentStop` — a place to inject "never run
    `git stash pop` in a shared tree" *before* the subagent runs the
    destructive command.
  - `FileChanged` / `WorktreeRemove` — would surface the silent `rm`.
  - `UserPromptSubmit` — could prime context with the
    out-of-scope-failures allowlist so the assistant doesn't have
    to re-discover it.
  - `PreCompact` — could snapshot baseline state before compaction
    drops it.
  - `PostToolBatch` — would let a multi-edit turn be checked *once*
    at end-of-batch instead of once per edit.

## Cost / impact

- **Tokens.** The Stop block is the single largest source of
  recurring noise in the assistant's context in this codebase.
- **Compounded by acknowledgment.** Every firing tends to produce an
  assistant text response acknowledging the failures — doubling
  the per-turn token cost of an ambient failure.
- **Attention.** The assistant cannot tell "the failure I should fix"
  from "the failure the user told me is out of scope" without
  re-deriving that distinction every turn.
- **False positives crowd out real signal.** By turn 3 the assistant
  starts treating the block as background and may skim past a
  genuinely novel failure introduced by the current turn's edits.
- **`additionalContext` cost is real.** Anthropic flags this. Any
  future design must amortize per-firing cost against actionable-
  signal hit rate.
- **PostToolUse + Stop overlap is unbounded.** No per-turn budget;
  back-to-back tsc + bun test can dominate wall-clock latency on
  multi-edit turns.

## Invariants we want

- A turn that introduces zero new failures produces zero new hook
  feedback in the assistant's context.
- A failure the user has explicitly acknowledged as out-of-scope
  stops being reported until something about it changes (different
  file:line, different assertion, different message).
- A failure caused mid-flight by a sibling subagent is attributed to
  that subagent, not the current turn.
- Hook output token cost scales with the rate of *actionable* signal,
  not constant per turn.
- Filesystem mutations between turns (deletes, renames, untracked-
  file removals) are observable to the main session.
- Rules that ought to govern subagents are injected through the
  documented `SubagentStart` / skill-frontmatter pathway, not
  string-pasted into agent prompts at fan-out.
- The selection criteria for "what runs in a hook" are written down
  somewhere — a turn that's *just* documentation shouldn't pay for
  a whole-project tsc.

## Open questions

- Is `Stop` the right surface for *all* of these checks? `knip`
  configuration hints could move to an end-of-task gate
  (`bun run check:deep`) and silence 13 errors per firing.
- Should `PostToolUse` use the file-extension matcher to *avoid*
  firing on doc-only edits, or is the in-script filter the right
  shape?
- What's a stable failure identity that survives timing drift in
  test names? Probably *test file + describe block + test name*,
  hashed — but we'd need to confirm `bun test` exposes that
  consistently.
- Where would a "baseline of accepted failures" live? Git-tracked so
  it survives clean clones? Per-branch? Per-author? `.claude/` is
  the natural home if branch-scoped.
- Should the hook know about in-flight `Agent` tool spawns and
  defer veto until they complete? `SubagentStop` could drive this
  — only run the heavy checks once all subagents are done.
- Does `additionalContext` give us a way to inject "here are the
  acknowledged failures, ignore them" into the next turn? Cheaper
  than re-running the suite and silencing the output.
- Where exactly is the right point for injecting subagent operating
  rules — a `SubagentStart` global hook, or frontmatter hook on each
  agent definition? Latter is more surgical but requires every
  agent author to remember.
- Does the analyze sink (`gemma-watch`) belong in the realtime loop
  ("this looks like an ambient failure, suppress"), or stay an
  offline review tool?
- Should `PostToolBatch` replace the per-edit fan-out, so a multi-
  edit turn pays for one tsc instead of N?

## Non-goals for this PRD

- Designing the hook's new shape.
- Picking a config format for the baseline / acknowledgment layer.
- Choosing between `SubagentStart` global vs frontmatter-per-agent
  for rule injection.
- Migrating any of the current stages to a different cadence.

These belong in a follow-up design doc once the problem framing here
is shared with whoever owns the hooks.
