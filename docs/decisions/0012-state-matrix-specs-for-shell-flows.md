---
id: ADR-0012
title: State-matrix specs for critical shell flows
status: proposed
date: 2026-06-14
authors:
  - stuffbucket
supersedes: []
links:
  design_index: .design-context.md
  failure_modes: docs/design/failure-modes.md
  windows: docs/design/windows.md
related_files:
  src/lib/auth-controller.ts: auth state machine in code
  shell/src/main.ts: renders state transitions
  docs/spec/: existing feature specs
---

# State-matrix specs for critical shell flows

## Context

`docs/design/` covers visual + structural concerns thoroughly
(aesthetic, type, layout, color, motion, components, keyboard,
tokens, windows). It is silent on **interaction model**: what are the
states for each flow, what transitions exist, what triggers each,
and what does the UI look like in each.

The spec for "sign in" lives implicitly across:

- `src/lib/auth-controller.ts` — the state machine in code
- `shell/src/main.ts:renderAccount()` — the dispatcher
- `shell/src/api.ts:AuthStatus.state` — the type-level enumeration
- `tests/auth-controller.test.ts` — assertions per transition
- `shell/index.html` — `data-state-account` cards per visual state

Adding a new state (the most recent: `last_upstream_rejection`
banner; before that: gh-reuse; before that: account-switch reboot)
requires re-deriving the matrix mentally and editing each layer.
Misses happen — the un-exhaustive `accountKeyFor()` fall-through to
`unauthenticated` (ADR-0006) is exactly this failure.

The user's stated pain — *"the interaction model being well thought
through"* — has no document home. Designers, the controller author,
and the renderer author all build their mental model from the code.

## Decision

Add `docs/design/state-matrices/` with one document per critical
flow. Each document is the source of truth that the
controller, the discriminated union (ADR-0006), the renderer
(ADR-0004), the event payloads (ADR-0007), and the tests are
expected to match.

Initial set:

- `auth.md` — sign-in / sign-out / token refresh / upstream rejection
- `account-switch.md` — multi-account switch + sidecar reboot
- `app-enable.md` — enable / disable per app + conflict resolution
- `first-run.md` — first launch, no config, through first successful
  request (cross-references `docs/first-run-setup-prd.md`)

Each document follows a fixed structure:

```markdown
# <Flow name> state matrix

## States
- name: short identifier (matches AuthStatus.state etc.)
  description: one sentence
  required data: list of fields that must be populated in this state
  visual treatment: which card / what tone (link to components.md)
  user actions available: list

## Transitions
| From | Trigger | To | Side effects | Notes |

## Entry points
- which user actions / events / external signals can land us here cold

## Test coverage
- which tests assert each state's invariants
- which tests assert each transition

## Open variants
- states that are aspirational / not yet implemented
```

The matrix is **binding**: ADR-0006's discriminated union is derived
from `auth.md`; if the matrix changes, the type changes; if the
type changes, the matrix should already have changed.

## Alternatives considered

- **One mega-doc.** Repeats the pain of `.design-context.md` pre-split
  (context-window hogging, conflicts). One file per flow.
- **State machines as code (xstate, statelys).** Heavier; the value
  is in the human-readable spec, not the runtime library. Code
  state machines are still fine to use — but they shouldn't *be*
  the spec, because they're not the artifact a designer or a new
  contributor reads first.
- **PRD-only.** PRDs (`docs/*-prd.md`) cover initial design; they
  don't survive as living references. The state matrices are
  living: they're updated when a state is added.

## Consequences

- Adding a new state becomes: update the matrix → update the
  type (ADR-0006 makes the compiler list every call site) →
  update the controller → update the renderer. Each step has a
  visible artifact; nothing is implicit.
- Reviewers have a single document to check against when reading
  a PR that touches one of these flows.
- The `failure-modes.md` doc gets a new entry: *"a state was added
  in code without updating the matrix → reject."*

## Migration

1. Create `docs/design/state-matrices/` with a one-paragraph
   `README.md` explaining the convention.
2. Write `auth.md` first — it's the most painful flow today and
   the one whose absence has cost the most.
3. Write `account-switch.md` next — needed for ADR-0007 (events)
   to know which boot transitions to emit.
4. Write `app-enable.md` in tandem with ADR-0009 (app integration
   interface).
5. Write `first-run.md` last; cross-link the existing PRD.
6. Add a link table to `.design-context.md` § *When you're
   about to…* pointing at state matrices.

## Out of scope

- Diagrams / Mermaid renders. The Markdown tables are sufficient and
  diff well in PRs. If a flow grows past ~10 states, revisit.
- Runtime state-machine library adoption.
- Backend (non-UI) state machines (rate-limit, cache eviction); their
  invariants live in tests already and there's no cross-layer
  ambiguity to resolve.

## Open questions

- Should the matrices live under `docs/design/` or `docs/spec/`?
  They straddle: design owns visual treatment per state; spec owns
  the transition table. Put them under `docs/design/state-matrices/`
  because they're consumed first by UI-shaping work; cross-link from
  `docs/spec/`.
- Granularity of `account-switch.md` vs `auth.md`: should they
  merge? Recommendation: keep separate. Auth is per-account
  (sign in / out, refresh, error). Account switch is across
  accounts (which one is active, reboot orchestration). Different
  invariants, different audiences.
