# Windows: the app surface + the splash

The single-window redesign ([#343]; spec:
[`single-window-redesign.md`](../spec/single-window-redesign.md))
collapsed the app to **one UI surface**. What used to be separate
Settings and Dashboard windows is now a single sidecar-served page
(delivered into the user's browser tab) whose left nav scales as new
sections — Settings, the usage view, per-project tracking — enter it.
The only *native* window is the **splash** (boot + failure recovery),
which must survive a dead sidecar and so is a standalone embedded HTML
file.

This doc codifies the shared design language and the one architectural
constraint (the splash) that keeps a token-drift risk alive.

## What's shared

- Dark-first with light + system override (`prefers-color-scheme`).
- Crimson `--brand` for identity; teal `--accent` for interactive
  surfaces. Both are single-sourced from `theme.ts` — no per-surface
  redeclaration, so they can no longer drift.
- Fraunces + Commissioner pairing, with Fraunces rationed to the brand
  mark and **one** display heading per section.
- One token vocabulary (see [`tokens.md`](tokens.md)), one spacing
  scale, three surface levels, three elevation levels.

## Sections vs. a sidebar

**Scroll-only vs sidebar-nav is a function of section count, not a
stylistic choice.** A single-section view doesn't earn a sidebar; a
multi-section surface doesn't earn one giant scroll. The threshold is
"would a user need to jump to a specific section by name?" — not pixel
count. The unified app nav is architected to grow into a sidebar as
sections accrue.

## The splash: the one embedded surface

The main UI is styled from the generated
`shell/src/ui/styles/tokens.css` (sourced from `theme.ts`), so token
values are declared once. The **splash** is the exception: it boots
before any bundle loads, so it can't import `tokens.css` and inlines a
small amount of brand hex directly.

**Consequence:** the splash's inlined values must be kept in sync with
`theme.ts` by hand. This is the last single-source gap; wiring the
splash to the generator (or a build-time freshness check) is tracked
in #352 / #354. Until then, follow
[`change-checklists.md`](change-checklists.md) → *Changing a token
value*.

[#343]: https://github.com/stuffbucket/maximal/pull/343
