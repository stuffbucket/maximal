# Layout system

**All token values live in [`shell/src/tokens.css`](../../shell/src/tokens.css).**
This file describes structure, scope, and which token to reach for —
never the literal value.

## Window sizes

Dimensions below are window chrome, not tokens. Single source of truth
for window sizing is this table — keep `shell/src-tauri/tauri.conf.json`
and any setup window builder in sync.

| Window     | Default | Min      | Max      | Resizable | Notes |
|------------|---------|----------|----------|-----------|-------|
| Setup      | 520×620 | 480×560  | 720×800  | yes       | Single column, vertical scroll on overflow |
| Dashboard  | 960×720 | 720×560  | 1400×1000| yes       | One scrollable column with sectioned content |
| Settings   | 880×720 | 720×560  | 1200×900 | yes       | Sidebar + content pane |

Single-instance for all three (re-show + focus the existing window).
Position: center on first launch, then respect last position.

## Grid + columns

**Desktop only — no responsive breakpoints in v1.** OS enforces min
size; no mobile fallback.

- **Setup**: single column, content max ~440px, centered.
- **Dashboard**: single column, content max ~720px, left-aligned,
  cards full content width.
- **Settings**: `--sidebar-width` left rail + content pane.
  Content pane max-width = `--content-max`. Within the pane, form
  rows use a 33% label / 66% control split.

> Per-pixel column widths are spec, not tokens, because they describe
> *information architecture* rather than reusable values. If you find
> yourself reusing one, promote it (e.g., add `--content-max-wide`).

## Spacing

Use the `--space-*` scale. **No off-scale values.**

| Token | Use |
|---|---|
| `--space-1` | Hairline gaps |
| `--space-2` | Inline gaps inside a row |
| `--space-3` | Inline gaps; compact card-internal row gap |
| `--space-4` | Card-internal padding (vertical); card-to-card gap; form-row internal gap |
| `--space-5` | Section gap inside a window; window-edge to content (Dashboard, Setup) |
| `--space-6` | Section gap (large); window-edge to content (Settings pane) |
| `--space-7` | Inter-section gap on large windows |
| `--space-8` | Reserved for inter-section gaps on the widest windows |

## Surfaces (3 levels)

Layering — light steps cards forward of base, dark steps the same.

| Token | Use |
|---|---|
| `--surface-base` | Window background (`body`) |
| `--surface-card` | Cards, sidebar fill |
| `--surface-control` | Form controls, secondary buttons |

The user-themable accent overrides `--surface-card` deltas. The system
computes contrast against `--surface-card` (where most text sits) and
warns when text-on-card drops below WCAG AA. See
[`color.md`](color.md).

## Elevation (3 levels)

| Token | Use |
|---|---|
| `--elevation-card` | Cards in **light mode only** (dark mode relies on the surface step) |
| `--elevation-modal` | Modals |
| `--elevation-tooltip` | Tooltips, popovers |

**Don't add a fourth level.**

## Radii

| Token | Use |
|---|---|
| `--radius-input` | Inputs, buttons |
| `--radius-card` | Cards, code blocks |
| `--radius-chip` | Chips, count badges |
| `--radius-pill` | Status dots, round/pill badges (text-light only) |

## Z-axis order

| z-index | Layer |
|---|---|
| 0 | Base / card content |
| 10 | Sticky window header (Settings sidebar's top, Dashboard status strip) |
| 100 | Dropdowns, popovers, autocomplete results |
| 200 | Toasts ("Saved", "Copied to clipboard") |
| 300 | Modals (confirmation dialogs) |
| 400 | Tooltips (always on top so they're never occluded) |

Z-index values are constants in this layout system, not tokens; if
you need to reorder layers, edit this table and audit consumers.
