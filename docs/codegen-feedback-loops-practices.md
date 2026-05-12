# Codegen feedback loops — inner and outer

## Problem framing

LLM coding agents generate code in turns. Each turn is built on top of the artifacts of the previous turn, including the latent context the agent inferred from whatever the harness surfaced back to it. If a type error, a broken test, or a dead export is caught at PR review, the agent has already laid three more turns of code on top of the mistake — and the fix is now a refactor, not an edit.

The lever is latency. A signal that arrives before the next turn shapes the next generation. A signal that arrives after the next turn shapes a retroactive cleanup. The goal of this document is not "more checks" but **checks delivered inside the budget of the loop that consumes them**.

Two loops matter:

- The **inner loop** fires per edit. It must finish before the agent decides what to do next. Budget: <2s.
- The **outer loop** fires per turn (end of agent response). It must finish before the human reads the response. Budget: <5s.

Anything slower is a manual aggregate or a CI gate. Anything faster than the LSP can already do is a feature of your editor, not a separate practice.

## Two-tier model

| Loop | Hook point | Frequency | Latency budget | Default contents |
|---|---|---|---|---|
| Inner | PostToolUse on Edit/Write/MultiEdit | Every file write | <2s | Fast lint + logic lint + typecheck, parallel |
| Outer | Stop (end of agent turn) | Every assistant turn | <5s | Test suite (affected) + dead-code finder, parallel |
| Manual fast | `check:fast` script | On demand | <10s | Full typecheck + full lint |
| Manual deep | `check:deep` script | On demand, pre-PR | minutes | check:fast + tests + knip + dependency-cruiser + mutation |
| Observation | Side process tailing JSONL | Continuous | non-blocking | Local LLM meta-analysis |

The harness hook points are the load-bearing concept. In Claude Code these are `PostToolUse` and `Stop` in `.claude/settings.json`. In Cursor they are project rules + commands. In Cline they are workflow scripts. In a plain pre-commit setup the inner loop degrades to `pre-commit` and the outer loop degrades to `pre-push`. The two-tier shape survives the translation; only the wiring differs.

## Inner loop recipe

The inner loop runs three checks in parallel after every file modification, scoped to the edited file where possible. It is silent on success and exits with code 2 plus compact stderr on failure so the harness re-injects the failure into the agent's context.

### TypeScript / JavaScript

| Tool | Role | Typical latency |
|---|---|---|
| `oxlint` | Mechanical lint, ~50-100× faster than ESLint | 50–200ms |
| `eslint` with type-aware rules | Logic lint (`no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`) | 300–800ms |
| `tsc --incremental --noEmit` | Project typecheck (incremental cache critical) | 500–1500ms |

Spawn all three in parallel. The wall-clock time is the slowest, not the sum.

Worked example in this repo at `.claude/hooks/check-on-edit.ts`:

```ts
// Sketch — actual implementation is in the repo.
const checks = [
  Bun.spawn(["bunx", "oxlint", file], { stderr: "pipe" }),
  Bun.spawn(["bunx", "eslint", "--no-warn-ignored", file], { stderr: "pipe" }),
  Bun.spawn(["bunx", "tsc", "--noEmit", "--incremental"], { stderr: "pipe" }),
];
const results = await Promise.all(
  checks.map(async (p) => ({ code: await p.exited, err: await new Response(p.stderr).text() })),
);
const failures = results.filter((r) => r.code !== 0);
if (failures.length === 0) process.exit(0);
process.stderr.write(failures.map((f) => f.err.trim()).join("\n\n"));
process.exit(2);
```

### Python

| Tool | Role |
|---|---|
| `ruff check --quiet` | Mechanical + many logic rules in one pass |
| `pyright --outputjson` (or `mypy --no-error-summary`) | Typecheck |

Two checks, parallel. Ruff covers what oxlint + most of eslint would in TS-land, so the recipe is simpler.

### Go

| Tool | Role |
|---|---|
| `go vet ./...` | Compiler-adjacent lint |
| `staticcheck ./...` | Logic lint |

The Go compiler is already fast enough to be the typecheck; vet + staticcheck add what an LSP doesn't.

### Rust

`cargo clippy` is the right tool but is rarely <2s on a non-trivial crate. Scope to the changed crate (`cargo clippy -p <crate>`) and accept a higher budget (5s), or move clippy to the outer loop and lean on `rust-analyzer` for the inner loop.

### Generic principle

The toolchain is the implementation detail. The constraint is **the slowest check completes in <2s on a representative single-file edit**. If your typecheck is 12s on every save, your inner loop is one fast lint plus a typecheck moved to the outer loop. Don't pretend.

### Acceptance — inner loop

1. Create `tmp.ts` with `const x: number = "string";`. Save it via the agent. Confirm the agent transcript surfaces `Type 'string' is not assignable to type 'number'` within 2s.
2. Add an unused import. Save. Confirm a lint error surfaces.
3. Save a clean file. Confirm the hook produces no output and exits 0.

## Outer loop recipe

The outer loop runs at the end of each agent turn. Budget is generous (<5s) because frequency is lower. Two checks, parallel.

| Tool | Role |
|---|---|
| Test runner (affected-only) | Catch regressions before the human reads the diff |
| `knip` (or language equivalent) | Dead exports/files — flags orphaned code from refactors mid-turn |

Test runner choice:

| Runner | Affected-only support | Notes |
|---|---|---|
| `vitest` | `--changed` flag, watch mode is incremental | Best ergonomics for affected-only |
| `bun test` | No native affected flag; pass changed paths explicitly | Fastest startup |
| `jest` | `--onlyChanged` / `--findRelatedTests` | Slower startup, mature affected logic |
| `pytest` | `pytest-testmon` plugin | Plugin required; works well once warmed |
| `go test` | `go test ./<changed-pkg>/...` via diff | Manual scoping |

Worked example at `.claude/hooks/check-on-stop.ts`: same `Bun.spawn` + `Promise.all` shape as the inner loop, swapping the command list.

If the test suite cannot finish in 5s even with affected-only scoping, drop it to `check:fast` and keep only knip in the outer loop. A 30s outer loop that no one waits for is worse than a 1s outer loop that runs.

### Acceptance — outer loop

1. Break a test (`expect(1).toBe(2)`). Trigger the end of an agent turn. Confirm the failing test surfaces within 5s.
2. Export a function and never import it. Trigger Stop. Confirm knip flags it.
3. End a clean turn. Confirm zero hook output.

## Output discipline

The harness re-injects hook stderr into the agent on exit code 2. Every character in that stderr costs context tokens and signal-to-noise. Discipline:

- **Silent on success.** Zero bytes. No "✓ all checks passed".
- **Exit 2 on failure**, not 1. (Claude Code treats exit 2 as a re-injectable error; 1 is a hook misconfiguration.)
- **Stderr only**, compact. Strip ANSI color (`NO_COLOR=1`). Strip progress bars. Strip "compiled in 1.2s" footers.
- **One check's failure does not suppress another's.** Concatenate all failing checks' stderr; don't short-circuit. The agent benefits from seeing "this edit broke types AND lint" in one shot.

Well-shaped output (good):

```
tmp.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.

tmp.ts:1:7  no-unused-vars  'x' is assigned a value but never used.
```

Noisy output (bad):

```
> tsc --noEmit
ℹ Starting compilation in incremental mode...
✗ Found 1 error:

  tmp.ts:1:7
    Type 'string' is not assignable to type 'number'.

  Compilation finished in 1247ms.

> eslint .
... (200 lines of progress)
```

## Manual aggregates

Two scripts in `package.json` (or `Makefile`, or `justfile`). The names matter less than that they exist and the agent learns to invoke them.

```json
{
  "scripts": {
    "check:fast": "tsc --noEmit && eslint .",
    "check:deep": "bun run check:fast && bun test && knip && depcruise src"
  }
}
```

Latency tiering:

| Belongs in `check:fast` | Belongs in `check:deep` | Belongs in neither |
|---|---|---|
| Full typecheck | Full test suite | CodeQL / Semgrep (CI only) |
| Full-repo lint | Dead-code finder | Mutation testing (CI or nightly) |
| Schema validation | Architectural rules (dependency-cruiser) | Container builds |
| | Property-based tests | Performance benchmarks |

If `check:fast` exceeds 10s on a warm cache, split it. If `check:deep` exceeds 2 minutes, the affected-only story for tests needs work before adding more tools.

## Observation loop

Hooks emit a JSONL log per run. A side process tails it and feeds failures into a local LLM for meta-analysis. **This is observation, not gating.** It never blocks codegen, never modifies files, never writes to global state. Its only output is a stream the human watches alongside the agent.

What the meta-analysis catches that the agent doesn't:

- Thrashing (same error fixed and re-introduced across turns).
- Symptom-vs-root-cause patterns (agent disables a lint rule instead of fixing the cause).
- Drift (test suite shrinking, type assertions growing).

JSONL log shape (one line per hook invocation):

```json
{"ts":"2026-05-10T12:00:00Z","hook":"PostToolUse","tool":"Edit","file":"src/foo.ts","exitCode":2,"durationMs":1840,"stderr":"..."}
```

Worked example in this repo: `scripts/gemma-watch.ts` runs Gemma via Ollama and posts to a local viewer. The pattern is portable to any local model (llama.cpp, LM Studio, mlx-lm) or any small cloud model. Backpressure: if the analyzer is behind, drop entries from the middle of the queue, not the head or tail; the head shows the trigger, the tail shows the current state.

`bun run analyze` starts the watcher. It is never invoked from a hook.

## Hook-harness specifics

### Claude Code

`.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "bun .claude/hooks/check-on-edit.ts" }]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "bun .claude/hooks/check-on-stop.ts" }]
      }
    ]
  }
}
```

The hook script reads JSON from stdin to learn which file was edited; the harness passes tool input there.

### Cursor

Cursor doesn't have direct equivalents of PostToolUse / Stop. Approximate with:

- A project rule in `.cursorrules` that instructs the agent to run `check:fast` after each substantive edit.
- A pre-commit hook (husky / lefthook) running the inner-loop commands so the signal arrives at commit time at the latest.

### Cline / Codex CLI / Aider

These harnesses expose shell commands the agent can invoke but typically lack a hard PostToolUse hook. Wire `check:fast` and `check:deep` as npm scripts and instruct the agent (via system prompt or repo-level guidance file) to run them.

### Non-agentic / plain workflows

`pre-commit` for the inner-loop equivalent, `pre-push` or CI for the outer loop. `lefthook.yml`:

```yaml
pre-commit:
  parallel: true
  commands:
    oxlint: { run: bunx oxlint {staged_files} }
    eslint: { run: bunx eslint {staged_files} }
    tsc:    { run: bunx tsc --noEmit }
```

## Anti-patterns

- **Running the full test suite per edit.** Busts the budget within five seconds on any non-toy project. Move to outer loop or `check:deep`.
- **Coupling lint and test results into one exit code.** Now the agent can't tell whether to fix a type or rewrite a test. Concatenate stderr; let the content disambiguate.
- **Surfacing warnings as errors.** Warnings drown the loop in noise the agent can't action. Either promote a warning to error or suppress it from the hook.
- **Sequential checks with no data dependency.** `tsc && eslint && oxlint` triples your latency for no signal gain. Parallelize.
- **Environment-specific paths in hook scripts.** `/Users/alice/.nvm/...` in a committed hook breaks every other contributor and every other agent on the repo. Use `bunx`, `npx`, or `$PATH`.
- **Hooks that write to files or global state.** A hook that auto-formats on save is fine; a hook that writes to a shared cache outside the repo is not. The observability surface must not become a side-effect surface.
- **Multiple terminals as the unified surface.** One channel back to the agent. The agent reads stderr, not your Vite overlay.
- **Hooks installed in `~/.claude/settings.json` instead of `.claude/settings.json`.** Project hooks belong with the project; user hooks belong with the user.

## When NOT to use this

- **Greenfield repos with no tests yet.** The outer loop has nothing to run. Add it once you have a test that takes <5s.
- **CI-only / scripted code generation.** If no human or agent is in a loop on the code, there's no inner loop to speed up.
- **Toolchain not installed locally.** A hook that fails because `tsc` isn't on `$PATH` is worse than no hook. Verify install in the hook's first line and exit 0 with a one-time warning if missing.
- **Massive monorepos where typecheck is >30s even incremental.** The inner loop degrades to lint-only; typecheck moves to a watcher process that posts asynchronously into the editor LSP, not into the agent. (See open questions.)

## Acceptance test, end to end

1. With hooks installed, ask the agent to add an obviously broken file: `const n: number = "x";`.
2. Confirm the agent's next message references the type error (inner loop fired within 2s and re-injected).
3. Ask the agent to fix it, then break a test.
4. Confirm the outer loop surfaces the test failure at the end of the turn.
5. Save a clean file. Confirm the JSONL log has an entry with `exitCode: 0` and the agent transcript shows no hook output.

If all five pass, the loops are wired correctly.

## Dispatch and review loops

The two-tier model above stops at the developer's own keyboard. The moment a developer (or another agent) delegates a whole issue-to-PR cycle to a background subagent, three more loops appear above it. Same framing — hook point, frequency, latency budget — just slower clocks.

| Loop | Hook point | Frequency | Latency budget | Default contents |
|---|---|---|---|---|
| Dispatch | Issue claim + worktree spawn | Per delegated issue | minutes | Subagent runs its own inner+outer locally; emits commits + a PR |
| CI shepherd | GitHub check_run / workflow_run events on the PR | Per pushed commit | minutes | Watch checks; on fixable failure, dispatch one followup agent with the annotation detail |
| Review / governance | PR review + merge | Per PR | hours–days | Human review; ADR-driven reconciliation for non-code state |

See the live playbook in `.claude/skills/pickup-issue/SKILL.md`.

### Dispatch loop

The loops below this one all assume the human is at the keyboard. The dispatch loop is what fires when they're not. A claim primitive (issue label `in-progress` + worktree branch `agent/issue-<N>`) takes an issue off the queue, spawns an isolated subagent in `../maximal-<task>`, and lets it run its own inner+outer until it pushes a PR. Hook point: the claim itself — without that atomic step two agents grab the same issue and stomp each other's worktrees.

Loop budget: one subagent per dispatch. The subagent is not allowed to dispatch its own subagents on the same issue. If it can't close out in its own turn budget, it surfaces back rather than recurring.

Self-evidencing artifacts: the `agent/issue-<N>` branch, the `in-progress` label on the issue, and the PR's `Closes #<N>` line. Anyone reading the issue queue can reconstruct who is on what without asking.

### CI shepherd loop

Once the subagent has opened a PR, the inner/outer loops it ran locally are no longer the gating signal — GitHub's check runs are. CodeQL, CI tests, and lint can flag things the local outer loop never sees (a new alert on freshly-added code, a flaky test surfacing under CI's runner). Hook point: `gh pr checks` polled after push, or `check_run`/`workflow_run` webhooks if you wire them.

Loop budget: **at most two followup commits per PR before surfacing to the human.** If a single rule re-fires after a fix, the issue's premise is wrong and the next iteration won't save it. The cap is documented in the pickup-issue skill and shows up as concrete behavior in PRs #10–#13.

Self-evidencing artifacts: the check run with its annotation-level detail (file, line, rule id) is what gets handed to the followup agent. The followup commit message references the rule id so the diff explains itself in `git log`.

### Review / governance loop

Human review is where the loop sometimes turns around: the reviewer pushes back on the *issue's premise*, not the diff. The durable artifact of that pushback is an ADR, not a comment. ADR-driven dismissals (introduced in PR #15) are the canonical example: non-code state — CodeQL dismissals, feature flags, policy decisions — is edited as a PR diff against `docs/decisions/<id>-<slug>.md`, and the merge triggers a reconcile workflow that applies the declared state to the live API. The ADR is the source of truth; the API is the reflection.

Hook point: the PR review itself, plus the `on: push` reconcile workflow that watches the ADR path. Loop budget: a normal review cadence; nothing here is auto-retried.

Self-evidencing artifacts: the PR diff (what changed), the ADR file with YAML frontmatter declaring the state (e.g. `codeql_dismissals:`), and the reconcile workflow run that closes the loop by mutating the live API.

### Patterns and anti-patterns

**Pattern — ADR with structured frontmatter + reconcile workflow.** `docs/decisions/0001-codeql-by-design-dismissals.md` declares dismissals under a `codeql_dismissals:` key; `.github/workflows/codeql-reconcile.yml` applies them on merge to main. (Both land in PR #15; cite them as the canonical shape even if not yet on main when you read this.) The diff is the audit trail. The workflow is idempotent. The reviewer is the policy gate.

**Pattern — smoke-test artifacts on PR comments.** Commit screenshots under `.github/pr-artifacts/issue-<N>/` and reference them by raw GitHub URL in the PR description. GitHub's HTML sanitizer strips `<img src="data:...">`, so inline base64 is a dead end; raw URLs work. The reviewer sees the page state without checking out the branch. PR #13 is the example.

**Anti-pattern — claiming `check:deep` green proves a UI change works.** It doesn't. `check:deep` typechecks and tests; it does not load a browser. Only a browser-driven smoke against `bun run --watch ./src/main.ts start --port 4141` exercises the rendered page. (The hardcoded port is correct here — `bun run dev` alone errors with "No command specified" on this repo.) The dispatched agent should attach the smoke artifact, not the check transcript.

**Anti-pattern — looping on the same CI failure more than twice.** If CodeQL re-fires the same rule after one fix, the framing is wrong. Surface "this rule fires because the proxy reads a token to call upstream — that's the product, not a bug" upward instead of editing the same line a third time. Two followups is the cap, not a target.

### How this composes

The dispatch, CI shepherd, and review/governance loops do not replace the inner and outer loops — they wrap them. The subagent runs its own inner+outer locally before it pushes; the dispatcher runs the review; the reviewer runs the governance loop on the ADR diff. Hook points stack: PostToolUse fires inside the subagent's turn, Stop fires at its turn boundary, `gh pr checks` fires at PR push, the reconcile workflow fires at merge. Each clock is slower than the one below it, and each loop's budget is set by what consumes its output. Latency-budgeted feedback all the way up.

## Open questions

- **Monorepos**: per-package hooks vs. whole-repo. Per-package keeps the budget; whole-repo catches cross-package type breaks. Likely answer: per-package inner, whole-repo outer, but it depends on package boundaries.
- **Huge codebases with slow typecheck**: whether to run a long-lived `tsc --watch` process that posts diagnostics out-of-band rather than spawning per edit. Reduces latency but adds a daemon to manage.
- **Shared vs. per-developer hook configs**: committed `.claude/settings.json` (or `.cursor/`) gives every contributor and every agent the same loop. Per-developer configs allow opting out but fragment the experience. Default to committed; allow override via `.claude/settings.local.json`.
- **What to do with flaky tests in the outer loop**: a flaky failure poisons the next turn's context. Quarantine list? Retry once? Currently unsolved.
- **Whether to gate on the observation loop's meta-analysis**: tempting (agent gets a "you're thrashing" nudge) but breaks the rule that observation never blocks. Probably belongs as a one-shot review the human triggers, not a hook.
- **Cross-language repos**: which loop owns the polyglot edit? Likely the file extension dispatches to a per-language inner-loop script; the outer loop runs everything.
