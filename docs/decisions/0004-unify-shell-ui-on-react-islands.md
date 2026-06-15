---
id: ADR-0004
title: Unify the shell on the React-island UI model
status: proposed
date: 2026-06-14
authors:
  - stuffbucket
supersedes: []
links:
  prior_adr: docs/decisions/0002-api-clients-react-island.md
  design_context: .design-context.md
  windows_doc: docs/design/windows.md
related_files:
  shell/src/main.ts: 1360-line imperative vanilla entrypoint (the migration target)
  shell/index.html: 686-line static markup driven by data-section/data-field/data-state-* attributes
  shell/src/features/api-clients/: existing React island (ADR-0002)
  shell/src/features/apps/: existing React island
  shell/src/ui/: 5 vendored primitives (Button, Checkbox, ConfirmDialog, Switch, Table)
  src/pages/usage-viewer.{html,js,css}: a third, separate vanilla UI (1088 + 320 lines)
---

# Unify the shell on the React-island UI model

## Context

The Tauri shell currently runs three parallel UI models:

1. **Imperative vanilla** — `shell/src/main.ts` (1360 lines) drives the
   static `shell/index.html` (686 lines) via `data-section`,
   `data-field`, and `data-state-account` attributes. State is
   reflected by toggling `hidden` and writing `textContent` into
   slots. Sections covered: Account, Endpoint, Logs, Diagnostics.
2. **React islands** — `shell/src/features/api-clients/` (ADR-0002)
   and `shell/src/features/apps/` mount into `<div>` hosts inside
   their `<section>` shells. Five primitives live under `shell/src/ui/`.
3. **Separate vanilla page** — `src/pages/usage-viewer.{html,js,css}`
   is served by the proxy itself, with its own copy of design tokens
   (see ADR-0008) and no shared code with the shell.

Adding a feature today requires picking a model and re-deriving form
rows, status banners, error cards, polling glue, and state-toggle
machinery from scratch. The settings shell's recent state additions
(device-code, gh-reuse, account-switch pending, upstream-rejection,
foreign-base-url conflict) have each forced edits across `index.html`,
`main.ts`, and a per-section helper module, and the `accountKeyFor`
mapping at `main.ts:396-402` is not exhaustive over `AuthStatus.state`.

ADR-0002 chose React as an island for one section but explicitly
deferred Account/Logs/Diagnostics migration. The cost of staying split
is now larger than the cost of finishing the migration: every cross-
cutting change (token rename, status-field rename, new auth state)
must be made twice in two languages of UI.

## Decision

Migrate the remaining settings sections — **Account**, **Endpoint**,
**Logs**, **Diagnostics** — to React islands under
`shell/src/features/<section>/`, following the structure of
`api-clients/` and `apps/`. After migration:

- `shell/src/main.ts` shrinks to a thin bootstrap: hash-based section
  routing, `showSection()`, busybar wiring, mount calls.
- `shell/index.html` keeps only `<section data-section="…">` shells
  with `<header class="section__head">` and a `<div id="…-root">`.
- The five vendored primitives expand only as features demand
  (likely additions: `FormRow`, `StatusBanner`, `StateCard`, `Field`).
- Hash-nav routing stays in `main.ts` (no React Router). React owns
  section bodies, not section visibility.

Migrate **`src/pages/usage-viewer.*`** in a second phase: move it
under `shell/src/features/usage-viewer/` and have the proxy serve a
built artifact from the shell bundle (or a separate Vite entry that
shares `shell/src/ui/` and `shell/src/tokens.css`). This is gated on
the Tauri/served-page split being resolvable; see *Open questions*.

## Alternatives considered

- **Stay split.** Cost compounds with every new state; the bug class
  the user spent a month on (auth reliability) is a direct
  consequence of imperative DOM glue.
- **Migrate vanilla outward.** Re-do the existing React islands in
  vanilla. Rejected: ADR-0002 documents why vanilla broke down for
  api-clients, and apps has equal complexity.
- **Move to a full framework page (one React app).** Heavier than
  islands and discards the working hash-nav model. Islands keep the
  blast radius small per migration step.

## Consequences

- Once a section is React, its state-toggle bugs collapse to "branch
  not handled" compile errors (gap #3, ADR-0006, depends on this).
- `bun test`'s HTML-grepping tests (`account-section.test.ts` etc.)
  need to evolve to component tests during the migration. Treat each
  section as a single PR with its tests rewritten alongside.
- New design primitives become reusable; new sections cost less.

## Migration order (suggested)

1. **Account** first — it has the most state and the most pain.
2. **Endpoint** — small, mostly text + copy buttons; good warm-up
   after Account.
3. **Diagnostics** — already partly templated.
4. **Logs** — smallest; trivial after the above.
5. **usage-viewer** — separate PR, gated on ADR-0008 (token unify).

## Out of scope

- Switching the design system (still bespoke tokens, no Tailwind).
- Replacing hash-nav with a router.
- Server-rendered React or any SSR.

## Open questions

- Should `usage-viewer` live in the same Vite build as the shell
  (multiple entries) or in a separate small Vite project that pulls
  in `shell/src/ui/` and `shell/src/tokens.css` as a workspace dep?
  The first is simpler; the second keeps the proxy-served bundle
  small. Decide when phase 2 starts.
- How to handle hash-nav state across React sections without prop
  drilling? A tiny `useHashSection()` hook in `shell/src/lib/` is
  probably enough — but defer until two sections need to read it.
