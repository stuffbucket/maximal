# Layout system

## Window sizes

| Window     | Default | Min      | Max      | Resizable | Notes |
|------------|---------|----------|----------|-----------|-------|
| Setup      | 520×620 | 480×560  | 720×800  | yes       | Single column, vertical scroll on overflow |
| Dashboard  | 960×720 | 720×560  | 1400×1000| yes       | One scrollable column with sectioned content |
| Settings   | 880×720 | 720×560  | 1200×900 | yes       | Sidebar (200px) + content pane |

Single-instance for all three (re-show + focus the existing window
instead of opening another). Position: center on first launch, then
respect last position.

## Grid + columns

**Desktop only — no responsive breakpoints in v1.** If a user makes
the window narrower than the min, the OS prevents it; we don't have
to build a mobile fallback.

- **Setup window**: single column, content max 440px wide, centered.
- **Dashboard window**: single column, content max 720px wide,
  left-aligned with 24px gutters either side; cards span the full
  content width.
- **Settings window**: 200px sidebar + content pane. Content pane
  max 640px (`--content-max`), left-aligned. Within the pane, form
  rows use a 33% label / 66% control split.

## Spacing scale

Token names — values in [`shell/src/tokens.css`](../../shell/src/tokens.css).

| Token | Value | Use |
|---|---|---|
| `--space-1` | 4px | Hairline gaps |
| `--space-2` | 8px | Inline gaps inside a row |
| `--space-3` | 12px | Inline gaps inside a row; compact card-internal row gap |
| `--space-4` | 16px | Card-internal padding (vertical), card-to-card gap, form-row internal gap |
| `--space-5` | 24px | Section gap inside a window; window-edge to content (Dashboard, Setup) |
| `--space-6` | 32px | Section gap (large); window-edge to content (Settings pane) |
| `--space-7` | 48px | Inter-section gap on large windows |
| `--space-8` | 64px | Reserved for inter-section gaps on large windows |

**Stick to these. No off-scale values.**

## Surfaces (3 levels)

| Token | Dark | Light | Use |
|---|---|---|---|
| `--surface-base` | `#0a0a0a` | `#fafafa` | Window background |
| `--surface-card` | `#161616` | `#ffffff` | Cards, sidebar |
| `--surface-control` | `#1f1f1f` | `#f0f0f0` | Inputs, buttons |

These are defaults; the user-themable accent overrides
`--surface-card` and `--surface-control` deltas independently. The
system computes contrast against `--surface-card` (where most text
sits) and warns when text-on-card drops below WCAG AA. See
[`color.md`](color.md) for the contrast contract.

## Elevation (3 levels)

| Token | Value | Use |
|---|---|---|
| `--elevation-card` | `0 1px 2px rgb(0 0 0 / 0.06)` | Cards in light mode |
| `--elevation-modal` | `0 8px 24px rgb(0 0 0 / 0.18)` | Modals |
| `--elevation-tooltip` | `0 2px 6px rgb(0 0 0 / 0.10)` | Tooltips, popovers |

In dark mode the shadows are nearly invisible; the surface step
itself does the lifting. **Don't add a fourth level.**

## Radii

| Token | Value | Use |
|---|---|---|
| `--radius-input` | 6px | Inputs, buttons |
| `--radius-card` | 8px | Cards, code blocks |
| `--radius-chip` | 4px | Chips, count badges |
| `--radius-pill` | 9999px | Status dots, round badges (text-light only) |

## Z-axis order

```
0    base / card content
10   sticky window header (Settings sidebar's top, Dashboard status strip)
100  dropdowns, popovers, autocomplete results
200  toasts ("Saved", "Copied to clipboard")
300  modals (confirmation dialogs)
400  tooltips (always on top so they're never occluded)
```
