# Layout system

**All token values live in [`shell/src/ui/styles/theme.ts`](../../shell/src/ui/styles/theme.ts).**
This file describes structure, scope, and which token to reach for —
never the literal value.

## Window sizes

Dimensions below are window chrome, not tokens. They're set by the
window builders in `shell/src-tauri/src/lib.rs` (`tauri.conf.json`
declares no windows) — change them there and update this table.

| Window                                         | Default                        | Min                                            | Max                                                                   | Resizable | Notes                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Splash                                         | 440×240                        | —                                              | —                                                                     | no        | Frameless, transparent, centered; shown while the proxy starts, then dismissed                                                                                       |
| About                                          | 680×360                        | —                                              | —                                                                     | no        | Frameless, transparent, centered; reuses the splash's branded surface with the app mark, version, and website                                                        |
| Main (Unified Settings + Dashboard + Sessions) | 1100×720 first-launch fallback | Settings: 736×480; Dashboard/Sessions: 640×480 | Settings: 1100 width, unbounded height; Dashboard/Sessions: unbounded | yes       | Restores size, position, and maximized state; repairs invalid saved geometry before showing; single top bar with Settings tabs + a right-side three-surface switcher |

The unified window is single-instance: opening Settings, Dashboard or Sessions
re-shows and focuses the existing window and switches the active view in place.
The native policy is surface-aware: Settings clamps only its useful width, while
Dashboard and Sessions explicitly remove both maxima so their tables and graphs
can use additional space. A valid current size is preserved; switching to
Settings can narrow a wider observability window. Constraint changes are deferred
while maximized because applying them can unmaximize or resize the window on
supported platforms. Closing hides the window. Across process launches, Tauri's
window-state plugin restores inner size, outer position, and maximized state.
Visibility, decorations, and fullscreen are intentionally not restored. The
window is built hidden so restoration and geometry repair happen before its first
presentation.

## Grid + columns

**Desktop only.** The OS-enforced minimum is surface-aware: Settings stops at a
`736×480` logical inner area so its complete one-row tab bar retains separation
from the pinned utilities; Dashboard and Sessions can resize to `640×480`. These
minimums are independent of the first-launch fallback and restored geometry.
Native creation centers the
fallback with breathing room inside the monitor's work area. Before the hidden
window is shown, the shell restores explicitly, compares physical inner and outer
geometry with the monitor's physical work area, resets an invalid saved size to a
fitted fallback, and clamps an off-screen outer position. Native frame dimensions
are subtracted before a repaired inner size is applied. Surface maxima remain
logical constraints and are never derived from `devicePixelRatio`.

- **Dashboard**: single column in the wide observability container. The usage
  overview divides token rates from quota and cache details, followed by the
  full-width live graph and token usage. With no graphable traffic, that graph
  slot stays in place and explains what will appear once requests begin. The
  toolbar (period and range) wraps on a narrow window rather than overflow.
- **Sessions**: a peer view in the same persistent observability iframe. It owns
  a full-width live/recent session list and its empty state, while sharing the
  Dashboard's single `/token-usage/sessions` controller. The list keeps model,
  client, and session identity together; its sticky desktop headings stay in
  view during window scrolling, and narrow rows reflow instead of creating an
  inner horizontal scroller.
- **Settings**: `.topbar` header + centered single-column content pane.
  Section max-width = `--content-max`. Within the pane, form
  rows use a 33% label / 66% control split.

> Per-pixel column widths are spec, not tokens, because they describe
> _information architecture_ rather than reusable values. If you find
> yourself reusing one, promote it (e.g., add `--content-max-wide`).

## Spacing

Use the `--space-*` scale. **No off-scale values.**

| Token       | Use                                                                       |
| ----------- | ------------------------------------------------------------------------- |
| `--space-1` | Hairline gaps                                                             |
| `--space-2` | Inline gaps inside a row                                                  |
| `--space-3` | Inline gaps; compact card-internal row gap                                |
| `--space-4` | Card-internal padding (vertical); card-to-card gap; form-row internal gap |
| `--space-5` | Section gap inside a window                                               |
| `--space-6` | Section gap (large); window-edge to content (Settings pane)               |
| `--space-7` | Inter-section gap on large windows                                        |
| `--space-8` | Reserved for inter-section gaps on the widest windows                     |

## Surfaces (3 levels)

Layering — in both themes, cards step forward of base.

| Token               | Use                              |
| ------------------- | -------------------------------- |
| `--surface-base`    | Window background (`body`)       |
| `--surface-card`    | Cards, sidebar fill              |
| `--surface-control` | Form controls, secondary buttons |

Every text and control color is checked against all three surfaces
in both themes. See [`color.md`](color.md).

## Elevation (3 levels)

| Token                 | Use                                                                  |
| --------------------- | -------------------------------------------------------------------- |
| `--elevation-card`    | Cards (barely visible on dark, where the surface step does the work) |
| `--elevation-modal`   | Modals                                                               |
| `--elevation-tooltip` | Tooltips, popovers                                                   |

**Don't add a fourth level.**

## Radii

| Token            | Use                                              |
| ---------------- | ------------------------------------------------ |
| `--radius-input` | Inputs, buttons                                  |
| `--radius-card`  | Cards, code blocks                               |
| `--radius-chip`  | Chips, count badges                              |
| `--radius-pill`  | Status dots, round/pill badges (text-light only) |

## Z-axis order

| z-index   | Layer                                                                            |
| --------- | -------------------------------------------------------------------------------- |
| 0         | Base / card content                                                              |
| 10        | Fixed window chrome (the Settings busy bar)                                      |
| 20        | Tooltips (above cards)                                                           |
| top layer | Modals — native `<dialog>` (`ConfirmDialog`), above everything without a z-index |

Z-index values are constants in this layout system, not tokens; if
you need to add or reorder layers, edit this table and audit consumers.
