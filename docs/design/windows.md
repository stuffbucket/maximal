# Window family: Settings + Dashboard

The Settings window (`shell/`) and the Dashboard window
(`src/pages/usage-viewer.html`) share one design language. This doc
codifies what's shared, where they diverge, and the architectural
constraint that makes drift between them a permanent risk.

## What's shared

- Dark-first with light + system override (`prefers-color-scheme`).
- Same crimson `--brand` for identity. Same teal `--accent` for
  interactive surfaces — *in theory.* Currently drifted; see
  [`failure-modes.md`](failure-modes.md).
- Same Fraunces + Commissioner pairing, with Fraunces rationed to the
  brand mark and **one** display heading per window.
- Same token vocabulary (see [`tokens.md`](tokens.md)). Same spacing
  scale, three surface levels, three elevation levels.

## Where they diverge

| Concern | Dashboard | Settings |
|---|---|---|
| Sections | 1 (scroll-only) | 8 (sidebar nav) |
| Layout | Single column, ~720px max (not tokenized) | `--sidebar-width` rail + `--content-max` pane |
| Bundling | One embedded HTML file, separate `<style>` block | Vite-bundled multi-file (React + vanilla islands) |
| Tokens live in | `src/pages/usage-viewer.css` (independent declaration) | `shell/src/tokens.css` (imported by all shell CSS) |

**Scroll-only vs sidebar-nav is a function of section count, not a
stylistic choice.** A single-section window doesn't earn a sidebar; a
multi-section window doesn't earn the burden of one giant scroll. If
the Dashboard grows to two unrelated sections it gets typographic
breaks, not chrome; if it grows to five, it gets a sidebar like
Settings does. The threshold is "would a user need to jump to a
specific section by name?" — not pixel count.

## Sidecar-served vs Vite-served: an architectural constraint

The Dashboard is served by the proxy itself as a single embedded HTML
file (Bun's `import attribute` machinery embeds the file at build
time). It has no module resolution, no CSS imports, no bundler.

The Settings window is a Vite-bundled app that imports
`shell/src/tokens.css` like any other stylesheet.

**Consequence:** there is no shared CSS file. **Token values must be
duplicated in both places. Any token edit must be applied in both
locations.** The header of `shell/src/tokens.css` ("This is the ONE
file allowed to declare raw values") is true *within the shell* — the
Dashboard mirrors it by convention, not by import.

**Don't try to "fix" this by serving `tokens.css` from the proxy and
linking to it from the Dashboard:** that breaks the embed-everything
property the proxy depends on for single-binary distribution.

The right fix is mechanical: a build-time check (or pre-commit hook,
or test) that diffs the token declarations in `tokens.css` vs
`usage-viewer.css` and fails on mismatch. See
[`change-checklists.md`](change-checklists.md) → *Changing a token
value* for the manual workflow until that exists.
