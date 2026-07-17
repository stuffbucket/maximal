---
id: ADR-0008
title: Single source of truth for design tokens (kill the dashboard duplicate)
status: obsoleted
obsoleted_by: docs/spec/single-window-redesign.md
date: 2026-06-14
authors:
  - stuffbucket
supersedes: []
links:
  failure_modes: docs/design/failure-modes.md
  tokens_doc: docs/design/tokens.md
  change_checklist: docs/design/change-checklists.md
related_files:
  shell/src/tokens.css: canonical token declarations
  src/pages/usage-viewer.css: independent duplicate (drift documented)
  shell/index.html: shell entry that imports tokens.css
  src/pages/usage-viewer.html: dashboard entry that re-declares tokens inline
---

> **Obsoleted by the single-window redesign** (`docs/spec/single-window-redesign.md`
> §4, §11). This ADR exists to de-dupe tokens between the shell and the
> standalone dashboard/usage-viewer. That redesign **deletes** the dashboard and
> ports Usage into the shell SPA on the shared tokens — removing the duplicate
> this ADR was written to sync. This is the exit condition the ADR itself
> predicted (Consequences: "the script is moot once usage-viewer moves into the
> shell build"). Note: the canonical path is now `shell/src/ui/styles/tokens.css`,
> not `shell/src/tokens.css` as referenced below.

# Single source of truth for design tokens

## Context

Design tokens live in two places that drift:

| Token | `shell/src/tokens.css` | `src/pages/usage-viewer.css` |
|---|---|---|
| `--accent` | `#5198a6` | `#14b8a6` ← **different teal** |
| `--text-muted` (dark) | `#8a8a8a` | `#a1a1a1` |
| `--border-subtle` (dark) | `#2a2a2a` | `rgb(255 255 255 / 0.08)` |
| `--border-strong` (dark) | `#666666` | `rgb(255 255 255 / 0.18)` |
| `--accent-destructive` | present | absent |
| `--accent-hover` | absent | present |
| `--status-*` (error/success/warning/info) | absent | present |
| `--font-display` (Fraunces) | present | absent |
| Light theme block | present | absent |

`docs/design/failure-modes.md` labels this *"the highest-risk class of
design bug in the repo today"* and the Dashboard literally renders a
different teal than Settings. The dashboard re-declares tokens because
it is served by the proxy as a standalone HTML page rather than
bundled with the shell, so the Vite asset pipeline doesn't reach it.

The mitigation in `change-checklists.md` is *"any token edit must
touch both CSS files"* — manual, easy to miss, fails open.

## Decision

Eliminate the duplicate. Two acceptable implementations; pick one
based on whether ADR-0004's phase-2 (move usage-viewer into the shell
Vite build) lands first.

### Option A — generated `:root` block (preferred today)

1. Treat `shell/src/tokens.css` as canonical.
2. Add `scripts/sync-tokens.ts`: parses the `:root` (and theme)
   blocks from `shell/src/tokens.css`, writes the same blocks into
   `src/pages/usage-viewer.css` between `/* @sync-tokens:start */`
   and `/* @sync-tokens:end */` markers.
3. Wire it into the shell build (`bun run build` for the shell
   triggers it) **and** into a `bun run check:tokens` script that
   fails CI if the markers' content differs from a freshly
   generated copy.
4. Update `change-checklists.md` to replace the manual two-touch
   step with "run `bun run sync:tokens`."

### Option B — serve the canonical CSS from the proxy

1. The proxy exposes `GET /assets/tokens.css` that streams
   `shell/src/tokens.css` (or its built version) byte-for-byte.
2. `src/pages/usage-viewer.html` `@import`s it.
3. `src/pages/usage-viewer.css` keeps only dashboard-specific rules,
   never `:root` token declarations.

Option B is cleaner but couples the dashboard's startup to a network
request to itself; Option A is a pre-commit/build-time transform with
zero runtime cost. **Default to A.** Switch to B when usage-viewer
moves into the shell Vite build (ADR-0004 phase 2), at which point
both pages share the same import graph and the script is moot.

## Alternatives considered

- **Status quo with documentation.** Has not held; documented drift
  has been live for at least one release.
- **CSS modules / CSS-in-JS.** Bigger architectural change; the
  bespoke-token-CSS choice is load-bearing in `.design-context.md`.
- **Move tokens into JSON and generate both CSS files.** Adds a layer
  of indirection between the source of truth and the editing
  experience designers expect. The CSS is already declarative.

## Consequences

- The drift table in `docs/design/failure-modes.md` becomes empty
  after the first sync. **Keep the table itself** as scaffolding for
  future audit cycles, but mark it "synced as of YYYY-MM-DD."
- The Dashboard's `--accent` flips from `#14b8a6` to `#5198a6` (or
  vice versa — pick the canonical teal explicitly; see *Open
  questions*).
- Adding a new token requires editing only `shell/src/tokens.css`
  and `docs/design/tokens.md`. The dashboard picks it up on next
  build.
- Light theme finally renders in the dashboard (currently absent).

## Migration

1. Decide which teal is canonical (likely `#5198a6` per the
   shell — it's the value `.design-context.md` calls "humanist
   accent" in spirit).
2. Implement Option A's `sync-tokens.ts`.
3. Run it; commit the regenerated `usage-viewer.css`.
4. Add the CI check.
5. Update the failure-modes drift table to "synced."
6. Update `change-checklists.md`.

## Out of scope

- Tokens semantic redesign. This ADR is mechanical de-duplication.
- Per-window token overrides (none today; not needed).
- Theming runtime UI (user-selectable themes is a separate spec).

## Open questions

- Which teal wins? Argument for `#5198a6` (shell): it's documented in
  more places and matches the brand-aesthetic guidance for a
  humanist accent. Argument for `#14b8a6` (dashboard): more saturated,
  may have been tuned for the dashboard's denser data context. Hold
  a 15-minute squint test against both windows side-by-side before
  committing.
- Should the marker comments use `@sync-tokens` (chosen above) or a
  more generic `@generated` marker? Prefer the explicit one — it
  documents *what* generates the block.
