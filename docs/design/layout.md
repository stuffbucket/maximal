# Layout system

**All token values live in [`shell/src/ui/styles/theme.ts`](../../shell/src/ui/styles/theme.ts).**
This file describes structure, scope, and which token to reach for —
never the literal value.

## Window sizes

Dimensions below are window chrome, not tokens. They're set by the
window builders in `shell/src-tauri/src/lib.rs` (`tauri.conf.json`
declares no windows) — change them there and update this table.

| Window     | Default  | Min     | Max  | Resizable | Notes |
|------------|----------|---------|------|-----------|-------|
| Splash     | 440×240  | —       | —    | no        | Frameless, transparent, centered; shown while the proxy starts, then dismissed |
| Main (Unified Settings + Dashboard) | 960×720  | 640×480 | work area (`prevent_overflow`) | yes | Single top bar (`.topbar`) with consolidated Settings tabs + right-side Dashboard/Settings mode icon button |

The unified window is single-instance: opening Settings or Dashboard re-shows
and focuses the existing window and switches the active view in place. Closing hides it.

## Grid + columns

**Desktop only.** The OS enforces min size (`640×480`); `prevent_overflow` clamps initial size to the monitor's work area.

- **Dashboard**: single column, centered in a wide Tailwind
  `max-w-7xl` container, cards full content width.
- **Settings**: `.topbar` header + centered single-column content pane.
  Section max-width = `--content-max`. Within the pane, form
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
| `--space-5` | Section gap inside a window |
| `--space-6` | Section gap (large); window-edge to content (Settings pane) |
| `--space-7` | Inter-section gap on large windows |
| `--space-8` | Reserved for inter-section gaps on the widest windows |

## Surfaces (3 levels)

Layering — in both themes, cards step forward of base.

| Token | Use |
|---|---|
| `--surface-base` | Window background (`body`) |
| `--surface-card` | Cards, sidebar fill |
| `--surface-control` | Form controls, secondary buttons |

Every text and control color is checked against all three surfaces
in both themes. See [`color.md`](color.md).

## Elevation (3 levels)

| Token | Use |
|---|---|
| `--elevation-card` | Cards (barely visible on dark, where the surface step does the work) |
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
| 10 | Fixed window chrome (the Settings busy bar) |
| 20 | Tooltips (above cards) |
| top layer | Modals — native `<dialog>` (`ConfirmDialog`), above everything without a z-index |

Z-index values are constants in this layout system, not tokens; if
you need to add or reorder layers, edit this table and audit consumers.
