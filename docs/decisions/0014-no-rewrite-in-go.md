---
id: ADR-0014
title: Don't rewrite in Go — criteria for when to revisit
status: accepted
date: 2026-06-15
authors:
  - stuffbucket
supersedes: []
related_adrs:
  - docs/decisions/0006-auth-status-discriminated-union.md
  - docs/decisions/0011-mock-module-leakage-discipline.md
  - docs/decisions/0013-split-tauri-lib-rs.md
links:
  architecture: docs/architecture.md
  bun_policy: docs/bun-version-policy.md
---

# Don't rewrite in Go — criteria for when to revisit

## Context

The question "why not rewrite maximal in Go?" is reasonable enough
that it will keep being asked. Capturing the decision and the
criteria here so the next person (or the next session) can read
the answer instead of re-deriving it.

Current stack:

- **Sidecar / CLI**: TypeScript on Bun. ~10k source lines, 80+
  test files, ~16k test lines. Cross-language imports via Hono
  routes; types shared with the shell via `src/lib/settings-types.ts`.
- **Tauri shell**: ~2000 lines of Rust managing the menu-bar app
  (see ADR-0013 for a proposed split).
- **Settings UI**: HTML + CSS + vanilla TS + two React islands
  (see ADR-0002, ADR-0004) served from the shell's Vite bundle.

The hypothetical: replace the TS/Bun sidecar with a Go binary,
possibly also swap Tauri for Wails (Go's equivalent).

## What Go would actually buy

1. **Single static binary, no runtime dep.** Distribution becomes
   trivial outside the Tauri app bundle.
2. **Cross-compile.** `GOOS=windows GOARCH=amd64 go build` instead
   of Bun's nascent multi-target story.
3. **Lower memory + faster cold start** for an always-running
   daemon. Both already fine in Bun; Go is just better.
4. **No `mock.module` cross-file leakage** (ADR-0011's class of
   bug). Go testing is per-package.
5. **Goroutines for polling loops** are more natural than
   `async`/`await` + `AbortController`.
6. **No `.bun-version` pinning policy** to maintain
   (see `docs/bun-version-policy.md`).

## What Go would cost

1. **Discriminated unions are a regression.** ADR-0006 modeled
   `AuthStatus` as `z.discriminatedUnion("state", [...])` with
   per-variant required fields and exhaustive renderer dispatch.
   Go's analogue is `interface{} + type switch`; the compiler
   can't enforce exhaustiveness. The carve-out vs strict revert
   loop ADR-0006 documents would be harder to spot statically.
2. **Lose the official TS SDKs** (`@anthropic-ai/sdk`,
   `openai/openai`). Go equivalents exist but lag features and
   have weaker typing.
3. **Lose `zod` as the schema source of truth.** Go alternatives
   (`go-playground/validator` tags, hand-written validators, JSON
   Schema codegen) don't match the `src/lib/settings-types.ts`
   pattern's ergonomics.
4. **The shell stays TS regardless.** Settings UI is HTML/CSS/JS.
   You don't get language unification — you'd be Go sidecar + TS
   shell + Rust (or Go-Wails) Tauri.
5. **API translation becomes more verbose.** The proxy maps
   between three message shapes (Anthropic / OpenAI / Copilot).
   TS structural typing makes reshaping clean; Go nominal typing
   means each shape is its own `struct` and translation is
   field-by-field copies. ~30-50% more code.
6. **Rewrite cost.** ~16k test lines and ~10k source lines; even
   with two engineers full-time, months of zero-feature shipping.
7. **Tauri → Wails is not a win.** Swap ~2000 lines of Rust for
   ~2000 lines of Go in the shell. Same windowing concerns, same
   lifecycle. Wails is less mature than Tauri.

## Which current pain points would Go solve?

| Pain | Go fixes it? |
|---|---|
| UI state machines (ADR-0006 union) | **No — worse** |
| Shared types proxy↔shell (ADR-0005) | Slightly worse (needs codegen) |
| Tauri shell complexity (ADR-0013) | **No — same in Wails** |
| Test coherence / invariant tests | **No — language-agnostic** |
| Tauri value vs cost | **No — language-agnostic** |
| Misleading test scopes | **No — language-agnostic** |
| `mock.module` leakage (ADR-0011) | **Yes** (but DI already fixes it) |
| Binary distribution / cross-platform | **Yes, meaningfully** |

Net: Go solves binary distribution and a testing-discipline issue
already fixed by ADR-0011. It actively makes worse the type-level
modeling pain points we just spent effort improving.

## Decision

**Don't rewrite.** The ergonomic regression on type-level modeling
(discriminated unions, structural typing, zod-as-schema) hits
exactly the area of recent investment and exactly the area whose
weakness caused a month of sign-in pain (per the ADR-0006 context).
The binary-distribution benefit doesn't outweigh that for a tool
whose primary distribution path is the Tauri `.app` bundle.

## Alternatives considered

- **Full rewrite in Go now.** Costs documented above; benefits don't
  address current pain.
- **Partial port (Go sidecar, TS shell).** Doesn't deliver language
  unification (shell stays TS, Tauri stays Rust). Introduces a JSON
  contract boundary that's currently in-process via shared types.
- **Rewrite in Rust.** Even higher ergonomic cost than Go (more
  complex borrow-checker fight for an HTTP proxy use case); same
  rewrite cost. Worse trade.
- **Keep Bun, address binary distribution separately.** Bun's
  `bun build --compile` produces a single executable today; refine
  the packaging there if the pain is real. Cheaper than a rewrite.

## When to revisit

Triggers that would re-open the question, in increasing strength:

1. **Multi-platform becomes a hard requirement.** Today macOS-
   first; if Windows + Linux become first-class with daemon-style
   deployment, Go's cross-compile is meaningfully better than
   Bun's. Even then, evaluate Bun's `--compile` story first.
2. **The Tauri menu-bar app is deprecated.** If the product
   collapses to "pure CLI/daemon proxy," Go's sweet spot. The
   moment you keep the menu-bar app, you're polyglot regardless.
3. **Bun's TS support regresses or stalls.** Currently best-in-
   class. If that changes (acquisition, project death, sustained
   breaking changes), the calculus flips.
4. **A future contributor proposes a Go rewrite with a working
   prototype** that demonstrates the AuthStatus union + the
   Anthropic↔Copilot translation in idiomatic Go, with comparable
   line counts and stronger compile-time guarantees. If someone
   shows the cost is wrong, revisit.

Until at least one of those triggers fires, the right answer is
"no, and here's why."

## Out of scope

- The Tauri-vs-alternatives question. See ADR-0013 for the
  Rust-shell split and the open conversation about reducing
  Tauri's surface (tray-only Tauri, dropping the native Settings
  window, etc.). That's a separate axis from "which language is
  the sidecar in."
- The Settings UI's React island migration (ADR-0004). Same
  point — frontend language choice is independent of sidecar
  language choice.
- Adding cross-platform support without a rewrite. Worth its own
  scoped doc when there's product demand.
