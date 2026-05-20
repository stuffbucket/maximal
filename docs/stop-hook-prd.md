# PRD: Stop-hook behavior

Status: **observation + framing** — describes what we see in practice
and how it relates to what Anthropic's hook documentation prescribes.
Intent: give whoever owns the hook a sharp problem statement before
solutioning.

## What's actually in place today

`.claude/settings.json` registers two hooks:

- `PostToolUse` (matcher `Edit|Write|MultiEdit`) → `check-on-edit.ts`
- `Stop` (no matcher, timeout 120s) → `check-on-stop.ts`

`check-on-stop.ts` is well-layered. Quoting its own header:

> exit 0 = no veto (turn completes silently)
> exit 2 + stderr = veto (Claude Code surfaces the stderr to the user)
> Any other condition … MUST exit 0 silently.

Three stages run in parallel:

| Stage    | Command                  | Veto-capable | Per-stage timeout |
| -------- | ------------------------ | ------------ | ----------------- |
| `test`   | `bun test`               | yes          | 90s               |
| `knip`   | `bun run knip`           | yes          | 90s               |
| `design` | `bun run design:check`   | no           | 90s               |

The aggregator is the only writer of stderr and exit codes; runners
return structured `RunnerResult`s. Catastrophic safety net: any
uncaught exception or rejection logs and exits 0. The hook itself is
not broken — the observations below are about the *signal pattern* it
produces, not its implementation.

## Observed behaviors

### 1. Pre-existing failures re-fire indefinitely

The hook has no memory between turns. A test that was failing when
the session started is failing now and will fail next turn — each
firing is technically correct ("yes, this is broken") and identical
to the previous one.

Single session, observed sequence:

- `settings-route` 1e/1f/1g (401 vs 200) fired on 3 consecutive turns.
- `account-section` "error card uses the error variant" fired on the
  same 3 turns.
- Assistant eventually fixed both inline just to silence the hook,
  even though the goal was scope-bounded menu-bar-app work.

The hook treats each turn as a fresh test run with no notion of
"acknowledged out-of-scope failure."

### 2. In-flight async work shows as broken state

`Stop` fires once per assistant turn, but background `Agent` tool
work continues across turns. When one subagent has landed a helper
but the sibling that consumes it hasn't finished yet, the hook fires
`knip` "unused export" on the orphan helper.

Observed three times for `__resetActiveClientsForTests` while a
background agent was writing `tests/active-clients.test.ts`. The hook
sees a snapshot; the codebase is mid-edit.

### 3. Same failure, different formatting per firing

Test names with timing in them (`[131.36ms]`, `[117.62ms]`) make the
serialized output differ even when the underlying failure is
identical. There is no stable failure ID an assistant can hash to
recognize "I've seen this one already."

### 4. Hook output dominates assistant context

A single firing for 4 pre-existing failures was ≈600 tokens. Across 5
turns that's ≈3,000 tokens of repeated noise — larger than the
underlying conversation it sits inside.

### 5. Subagent collateral damage is invisible to the hook

Sequence observed in this repo:

1. Backend subagent ran `git stash pop` to "verify pre-existing test
   state."
2. The pop hit a conflict and left React-shell files in an
   inconsistent state.
3. Subagent ran `rm` on the unfamiliar files to "revert unrelated
   state" — wiping a sibling agent's untracked work.
4. The main session didn't notice for two more turns. The hook
   reports `bun test` and `knip` only; it has no view of "files
   deleted" or "git state mutated."
5. Damage surfaced only when the main assistant later ran `tsc`.

The hook misses the entire class where the source-of-truth filesystem
mutates silently between turns.

### 6. The hook can't distinguish "novel" from "ambient" failure

There's no diff against a baseline. Every failure reads as "the
assistant's fault on this turn," including ones that existed at
session start or were caused by a sibling background agent. The
assistant has to do this attribution by hand on every firing.

### 7. `knip` "Configuration hints" are unactionable padding

Each firing prints 13 "Remove from ignoreDependencies / ignoreBinaries"
hints. They've been hinted for weeks and no one has acted on them.
They are visual noise in every firing.

## How this relates to Anthropic's documented model

Anthropic publishes 29 hook event types but ships **no dedicated
"hook best practices" page**; guidance is embedded inline in the
hooks reference. What the docs *do* say is relevant:

- **`Stop` semantics.** Exit code 2 + stderr blocks the Stop action
  and surfaces output. Our hook honors this — it is using the
  contract correctly. The friction we see is downstream of "the hook
  is doing exactly what it's designed to do, repeatedly."
- **Subagent hook story.** `Stop` auto-converts to `SubagentStop` for
  subagents. `SessionStart` fires for every agent. Skill / agent
  *frontmatter hooks* run while the skill or agent is active —
  Anthropic's documented mechanism for injecting rules into spawned
  subagents. **We are not using this mechanism**; we string-paste
  rules into agent prompts at fan-out, which is forgettable and
  scales linearly with fan-out sites.
- **`hookSpecificOutput.additionalContext`**. Anthropic explicitly
  positions this for *environment state, conditional rules, external
  data* — and **not** for static rules (those belong in `CLAUDE.md`)
  and **not** for imperative instructions. We're not using it at all
  today.
- **Events we're not using that map onto observed problems.**
  - `SubagentStart` / `SubagentStop` — would have given us a place to
    inject the "never run `git stash pop` in a shared tree" rule
    *before* the subagent ran the destructive command.
  - `FileChanged` / `WorktreeRemove` — would have surfaced the
    silent `rm` of untracked React files.
  - `UserPromptSubmit` — could prime context with the "currently
    out-of-scope failures" allowlist so the assistant doesn't have to
    rediscover it.
  - `PreCompact` — could snapshot baseline state before compaction
    drops it.

## Cost / impact

- **Tokens.** The stop-hook block is the single largest source of
  recurring noise in the assistant's context in this codebase.
- **Attention.** The assistant cannot tell "the failure I should fix"
  from "the failure the user told me is out of scope" without
  re-deriving the distinction every turn.
- **False positives crowd out real signal.** By turn 3 the assistant
  starts treating the block as background noise and may skim past a
  genuinely novel failure introduced by the current turn's edits.
- **Token cost of `additionalContext` is real.** Anthropic flags this
  explicitly. Any future hook design has to amortize the per-firing
  cost against the hit rate of actionable signal.

## Invariants we want

- A turn that introduces zero new failures should produce zero new
  hook feedback in the assistant's context.
- A failure the user has explicitly acknowledged as out-of-scope
  should stop being reported until something about it changes
  (different file:line, different assertion, different message).
- A failure caused mid-flight by a sibling subagent should be
  attributed to that subagent, not the current turn.
- Hook output token cost should scale with the rate of *actionable*
  signal, not constant per turn.
- Filesystem mutations between turns (deletes, renames, untracked-file
  removals) should be observable to the main session.
- Rules that ought to govern subagents should be injected through the
  documented `SubagentStart` / skill-frontmatter pathway, not
  string-pasted into agent prompts at fan-out.

## Open questions

- Is `Stop` the right surface for *all* of these checks? `knip`
  configuration hints could move to an end-of-task gate
  (`bun run check:deep`) and silence 13 errors per firing.
- What's a stable failure identity that survives timing drift in test
  names? Probably *test file + describe block + test name*, hashed —
  but we'd need to confirm `bun test` exposes that consistently.
- Where would a "baseline of accepted failures" live? Git-tracked so
  it survives clean clones? Per-branch? Per-author? `.claude/` is the
  natural home if branch-scoped.
- Should the hook know about in-flight `Agent` tool spawns and defer
  veto until they complete? Anthropic's `SubagentStop` event could
  drive this — only run the heavy checks once all subagents are done.
- Does `additionalContext` give us a way to inject "here are the
  acknowledged failures, ignore them" into the next turn? Cheaper
  than re-running the suite and silencing the output.
- Where exactly is the right point for injecting subagent operating
  rules — `SubagentStart` hook globally, or frontmatter hook on each
  agent definition? The latter is more surgical but requires every
  agent author to remember.

## Non-goals for this PRD

- Designing the hook's new shape.
- Picking a config format for the baseline / acknowledgment layer.
- Choosing between `SubagentStart` global vs frontmatter-per-agent
  for rule injection.

These belong in a follow-up design doc once the problem framing here
is shared with whoever owns the hook.
