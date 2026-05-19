# PRD: Stop-hook behavior

Status: **observation only** — describes what we see in practice, no
solution prescribed. Intent is to give whoever owns the hook a sharp
problem statement before they design the fix.

## What the stop hook is today

`bun run $CLAUDE_PROJECT_DIR/.claude/hooks/check-on-stop.ts` runs at the
end of every assistant turn. It executes `bun test`, `knip`, and (per
turn) prints the failures verbatim back into the conversation as a
`Stop hook feedback` message. The assistant sees that feedback on the
next turn and is expected to either fix the reported problem or
account for it.

## Observed behaviors

These are recurring patterns over a multi-day session of agentic work
on this repo.

### 1. Pre-existing failures re-fire indefinitely

If a test was already failing when the assistant started work, the
hook reports it on every turn until it's fixed. The assistant has no
way to mark "seen, out of scope" — each firing reads as new feedback.
Observed in a single session:

- `settings-route` 1e/1f/1g (401 vs 200) fired on 3 consecutive
  assistant turns despite being unrelated to in-flight work.
- `account-section` "error card uses the error variant" fired on the
  same 3 turns.
- The assistant eventually fixed both inline just to silence the hook,
  even though the goal was scope-bounded menu-bar-app work.

The hook treats each turn as a fresh test run with no memory of
previously-emitted findings.

### 2. In-flight async work shows as broken state

When a background subagent is mid-write — has landed a helper but not
yet the test that uses it — the hook fires `knip` "unused export"
warnings. Observed three times in one session for
`__resetActiveClientsForTests` while the agent was still writing
`tests/active-clients.test.ts`.

The hook has no view of in-flight `Agent` tool work; every snapshot
looks final.

### 3. Same failure signature, different formatting per firing

A single underlying failure (e.g. `card--error` class mismatch)
serializes slightly differently across firings (timing in the test
name, line offsets), so the assistant can't easily hash and dedup the
incoming feedback. There is no stable failure ID.

### 4. Hook output dominates assistant context

A single stop-hook firing for the 4 pre-existing failures was ~600
tokens; multiplied across 5 turns of the same failures, that's
≈3,000 tokens of repeated noise per session. Larger than the
underlying conversation was.

### 5. Subagent collateral damage is invisible to the hook until much
   later

Sequence observed:

1. Backend subagent runs `git stash pop` to "verify pre-existing test
   state."
2. The pop produces a merge conflict with another worktree's stash
   and silently leaves uncommitted React-shell files dirty.
3. The agent runs `rm` on the unfamiliar files to "revert unrelated
   state."
4. The main assistant doesn't notice for two more turns — the hook
   only reports `bun test` and `knip` failures, not file deletions or
   git-state mutations.
5. The damage surfaces as a TS compile error when the main assistant
   finally runs `tsc`.

The hook misses the class of failure where the source-of-truth
filesystem changes silently between turns.

### 6. The hook can't distinguish "novel failure caused by this
   turn's edits" from "ambient failure"

There's no diff against a baseline. Every failure looks like the
assistant's fault, including ones that were already there when the
session started or ones caused by a sibling agent.

### 7. The "Configuration hints" knip section is unactionable

`knip` prints 13 "Remove from ignoreDependencies / ignoreBinaries"
hints on every firing. They've been hinted for weeks. No one acts on
them; they're just visual padding.

## Cost / impact

- Tokens: the stop-hook block is the single largest source of
  recurring noise in the assistant's context across this codebase.
- Attention: the assistant cannot tell "the failure I should fix"
  from "the failure the user explicitly told me is out of scope"
  without re-explaining each time.
- False positives → real bugs missed. By turn 3, the assistant starts
  treating the block as background noise and may skim past a genuinely
  novel failure.

## What we want to be true (not how to get there)

- A turn that introduces zero new failures should produce zero new
  hook feedback.
- A failure the user has explicitly acknowledged as out of scope
  should stop being reported.
- A failure caused mid-flight by a sibling subagent should not be
  blamed on the assistant's current turn.
- The cost of running the hook (in tokens + attention) should be
  proportional to the value of its findings, not constant per turn.

## Open questions

- Is the hook the right surface for *all* of these signals, or should
  things like `knip` configuration hints live somewhere quieter (a
  manual `bun run check:deep` rather than every turn)?
- What's a stable failure identity that survives line-number drift?
  (Test name + assertion site? Test file + describe block + name
  hash?)
- Where would a "baseline of accepted failures" live? Git-tracked, so
  it survives clean clones? Per-branch? Per-author?
- Should the hook know about in-flight `Agent` tool spawns and defer
  until they complete?

## Non-goals for this PRD

- Designing the hook's new shape.
- Picking a config format.
- Defining a "baseline file" schema.

These belong in a follow-up design doc once the problem statement
above is shared with whoever owns the hook.
