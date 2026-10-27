# Window family: Settings + Dashboard

The Settings window (`shell/ui/settings/index.html` + `shell/src/`) and
the Dashboard window (`shell/ui/dashboard/` + `shell/src/dashboard/`)
share one design language. This doc codifies what's shared and where
they diverge.

## What's shared

- Follow the OS appearance (`prefers-color-scheme`), dark when it gives
  no preference; `data-theme` on `<html>` pins one. Same generated theme
  blocks in both windows.
- Same crimson `--brand` for identity. Same teal `--accent` for
  interactive surfaces.
- Same Commissioner body face. Fraunces is rationed to the brand mark
  and **one** display heading per window; the Dashboard has no display
  moment, so it doesn't load Fraunces.
- Same token vocabulary and values, generated from
  `shell/src/ui/styles/theme.ts` (see [`tokens.md`](tokens.md)). Same
  spacing scale, three surface levels, three elevation levels.
- Both are built by Bun (`scripts/build-ui.ts`) and served by the proxy
  under `/ui/settings/` and `/ui/dashboard/`.

## Where they diverge

| Concern | Dashboard | Settings |
|---|---|---|
| Sections | One scroll; typographic section headings, no nav | 9 (sidebar nav) |
| Layout | Single column in a Tailwind `max-w-7xl` container (not tokenized) | `--sidebar-width` rail + `--content-max` sections |
| Build | Hand-authored HTML + `style.css` copied verbatim; only `shell/src/dashboard/main.ts` is bundled. Tailwind and Lucide load as vendored classic `<script>`s | Bun bundles `index.html` and its imports (React + vanilla islands) |
| Tokens live in | Generated region of `shell/ui/dashboard/style.css` (a subset — see [`failure-modes.md`](failure-modes.md) → *Known active drift*) | `shell/src/ui/styles/tokens.css`, imported by `styles.css` |

**Scroll-only vs sidebar-nav is a function of section count, not a
stylistic choice.** A single-section window doesn't earn a sidebar; a
multi-section window doesn't earn the burden of one giant scroll. The
Dashboard's few related sections get typographic breaks, not chrome;
if it grows to five unrelated ones, it gets a sidebar like Settings
does. The threshold is "would a user need to jump to a
specific section by name?" — not pixel count.
