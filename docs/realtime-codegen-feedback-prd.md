# PRD: Realtime Expert-Level Feedback for LLM Codegen

## Problem

LLM-generated code typically fails in ways type checkers and basic linters miss: floating promises, non-exhaustive switches, silent `any`, layering violations, near-duplicate reimplementations of existing helpers, unsafe data flow, and tests that exercise without pinning behavior. Catching these post-hoc (PR review, CI) is too late — the model has already built more code on top. We need feedback that fires fast enough to influence the next generation, not the next PR.

## Goal

A development loop where an LLM (or human) writing code receives expert-reviewer-quality feedback in the same window as the keystroke that produced it. Target: <1s for the inner loop, <10s for the deeper checks, all surfaced through a single coherent channel.

## Non-Goals

- Replacing human review on PRs.
- Achieving zero false positives — dataflow tools have inherent FP rates on dynamic JS; the goal is signal density, not purity.
- Deno or alternate-runtime support. Targets Vite + Bun + TypeScript.

## Success Criteria

- Type, lint, and architectural errors visible in <1s of save on a representative file.
- Test feedback on changed file <3s.
- Dead-code, duplication, and structural violations surfaced before the next commit.
- Security/dataflow signal available pre-PR (not blocking the inner loop).
- One unified error surface (Vite overlay + LSP diagnostics), not ten terminals.

## Feedback Layers

### L1 — As-you-type (50–200ms)

| Tool | Role |
|---|---|
| TypeScript LSP, strict++ | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `useUnknownInCatchVariables` |
| `oxlint` | Mechanical lint pass, ~50–100× faster than ESLint |
| `ts-reset` | Patches built-in types so `JSON.parse`, `.filter(Boolean)`, etc. don't silently widen to `any` |

### L2 — On save (200ms–1s)

| Tool | Role |
|---|---|
| `vite-plugin-checker` | Unifies TS + ESLint into the browser overlay |
| ESLint with `@typescript-eslint` logic rules | `no-floating-promises`, `no-misused-promises`, `no-unnecessary-condition`, `switch-exhaustiveness-check`, `no-base-to-string`, `await-thenable` |
| `dependency-cruiser` or `eslint-plugin-boundaries` | Architectural layer rules (e.g. UI ↛ server) as errors |

### L3 — On file change (1–3s)

| Tool | Role |
|---|---|
| `vitest --watch` | Affected-only reruns, colocated tests |
| `zod` / `valibot` at boundaries | Wrong-shape responses fail loudly at the boundary, not three calls deep |
| `ts-pattern` | Exhaustive matching on discriminated unions, enforced by types |

### L4 — On pause / pre-commit (3–10s)

| Tool | Role |
|---|---|
| `knip` | Dead exports/files — flags drift when new code orphans old code |
| `jscpd` | Near-duplicate detection — flags reimplementations of existing utilities |
| `ast-grep` rules | Project-specific structural patterns (e.g. no `fetch` outside `src/services/`) |

### L5 — Background, async surface (10s+)

| Tool | Role |
|---|---|
| CodeQL (default setup) or Semgrep Pro | Taint analysis: SQL injection, SSRF, prototype pollution, path traversal |
| `fast-check` | Property-based tests on critical pure functions, run in worker |
| Stryker, scoped to diff | Mutation testing — the only tool that answers "do tests pin behavior?" |

## Connective Tissue

- **Unified error sink**: all diagnostics route to Vite's overlay and the LSP channel. No tool gets its own terminal pane.
- **Incremental everything**: `tsc --incremental`, Turbo/Nx cache, vitest affected-only, oxlint per-file. Anything that can't stay <2s on single-file change drops out of the inner loop.
- **Strict tsconfig + path aliases + `CLAUDE.md`**: the model's mental model matches what the tools enforce, raising first-try pass rate.

## Minimum Viable Bundle

If only two additions are made to a stock Vite/Bun/TS repo:

1. **`oxlint` + `vite-plugin-checker`** — sub-second inner loop with all errors in one overlay.
2. **`zod` parses at every external boundary** — turns a large class of "looks right, fails at runtime" bugs into immediate, localized failures.

## Recommended Bundle (full)

```
L1 (LSP):       tsc strict++ · oxlint · ts-reset
L2 (save):      vite-plugin-checker · ESLint logic rules · dependency-cruiser
L3 (test):      vitest --watch · zod boundaries · ts-pattern
L4 (pause):     knip · jscpd · ast-grep rules
L5 (background) CodeQL · fast-check · Stryker (diff-scoped)
```

## Risks / Tradeoffs

- **False positives** in L5 (CodeQL, Stryker) can train the model — and the human — to ignore signal. Keep L5 advisory, never blocking.
- **Tool sprawl**: the value comes from the unified surface, not the tool count. Adding a tool that ships its own UI is a regression.
- **Lint rule drift**: ESLint configs can grow until full-repo lint exceeds the inner-loop budget. Keep ESLint scoped to logic rules; let oxlint/Biome handle mechanics.
- **CodeQL latency**: not viable inline; treat as a PR gate that posts back into the overlay asynchronously.

## Open Questions

- Biome vs. oxlint for L1 — Biome has broader rule coverage; oxlint is faster. Pick after benchmarking on this repo.
- Whether `dependency-cruiser` rules belong in CI only or also as an LSP diagnostic via its ESLint adapter.
- Whether to wire CodeQL results back into the Vite overlay via a custom plugin, or leave them as GitHub PR annotations.

## Out of Scope (for now)

- Runtime tracing / OpenTelemetry in dev — useful, but a separate workstream.
- Agent-specific harness changes (worktree orchestration, context packing). Covered elsewhere.
- Rust/Tauri-side equivalents (`clippy`, `cargo check`, MIRAI/Kani). Mirror structure, separate doc.
