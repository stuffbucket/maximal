# Layout system

**All token values live in [`ui/theme.ts`](../../ui/theme.ts).** Generated
stylesheets expose them to both desktop renderers. This file describes
structure, scope, and which token to reach for — never the literal value.

## Window sizing

Electron window bounds belong to the client window configuration, not the token
system. The canonical workspace is resizable with an enforced desktop minimum;
restore a person's last usable position and size. Singular secondary tasks use
single-instance windows that re-show and focus rather than duplicate.

## Grid + panels

**Desktop only — no mobile breakpoint contract.** The workspace may adapt when
space is constrained, but it does not collapse into a phone layout.

- `--titlebar-height` reserves the renderer's draggable titlebar region.
- `--panel-width` sizes persistent navigation or inspector panels.
- `--sidebar-width` remains the legacy settings navigation width.
- Prose uses `--content-max`; data-dense workspace regions may use
  `--content-max-wide`.
- Standard and dense controls use `--control-height` and
  `--control-height-compact` respectively.

Promote a repeated structural measurement to `tokens.md` before adding it to
`ui/theme.ts`; one-off composition remains local to the approved renderer plan.

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

The shipped themes use fixed, contrast-verified surface deltas. Runtime user
surface overrides are not yet implemented; their required warning and focus
validation contract is documented in [`color.md`](color.md).

## Elevation (3 levels)

| Token | Use |
|---|---|
| `--elevation-card` | Cards in **light mode only** (dark mode relies on the surface step) |
| `--elevation-modal` | Legacy modal surfaces |
| `--elevation-dialog` | Electron dialogs and confirmation layers |
| `--elevation-tooltip` | Tooltips, popovers |

Do not add another elevation role without documenting a distinct z-layer.

## Radii

| Token | Use |
|---|---|
| `--radius-input` | Inputs, buttons |
| `--radius-card` | Cards, code blocks |
| `--radius-dialog` | Electron dialogs and confirmation layers |
| `--radius-chip` | Chips, count badges |
| `--radius-pill` | Status dots, round/pill badges (text-light only) |

## Z-axis order

| z-index | Layer |
|---|---|
| 0 | Base / card content |
| 10 | Desktop titlebar and sticky panel headers |
| 100 | Dropdowns, popovers, autocomplete results |
| 200 | Toasts ("Saved", "Copied to clipboard") |
| 300 | Modals (confirmation dialogs) |
| 400 | Tooltips (always on top so they're never occluded) |

Z-index values are constants in this layout system, not tokens; if
you need to reorder layers, edit this table and audit consumers.
