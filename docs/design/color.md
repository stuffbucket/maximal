# Color

Four roles, deliberately split to keep each from flooding the surface.
**Token values are sourced from [`ui/theme.ts`](../../ui/theme.ts)** and
generated into both desktop token stylesheets.
This file describes role, scope, and the reasoning behind the split.

| Token | Role |
|---|---|
| `--brand` | Crimson. **Identity only.** Mark, hero, badging, attention-state tray dot. |
| `--accent` | Warm bronze. **Interactive surfaces.** Primary buttons, switches, focus rings, active nav. |
| `--accent-destructive` | Crimson-adjacent. **Destructive actions only.** |
| `--link` | Cool slate. **Prose links only.** |

Foreground pairings: `--brand-fg`, `--accent-fg`,
`--accent-destructive-foreground`.

## Why the split exists

The crimson was historically dual-purposed: brand mark *and* primary
button fill *and* focus ring. Every interactive surface read as
"brand" — so the brand stopped reading as anything special, and the
UI felt shouty.

Pulling interactive duty onto warm bronze `--accent` recovers the brand
voice (it appears once or twice per window, deliberately) while giving
controls a crafted warmth that remains distinct from crimson identity.

## Destructive is not brand

`--accent-destructive` stays in the crimson family because
destructive actions want urgency, which is the one place the brand's
warning-red quality earns its keep. It is **not** the same value as
`--brand` — destructive is a hair deeper so it reads as "caution"
rather than "identity."

## Link is cool against the warm roles

`--link` and `--link-hover` use a low-chroma cool slate, deliberately
separate from both crimson identity and bronze interaction. They shift
lighter on dark and darker on light so each theme clears WCAG AA against
both `--surface-base` and `--surface-card`. An inline prose link therefore
never reads as either identity or a filled primary action.

The canonical palette's measured contrast is recorded in this document's
contrast verification section. Re-measure whenever a paired token changes.

## Contrast contract

- **Target: WCAG AA** — 4.5:1 for normal text and 3:1 for focus
  indicators. AAA where reachable without sacrificing the palette.
- The shipped themes use the canonical palette from `ui/theme.ts`; there is no
  runtime accent or surface-color picker yet.
- **Contrast is ours.** Before user color overrides ship, the application must
  measure text against `--surface-card` at 4.5:1 and focus indicators against
  every surface they touch at 3:1, then show a warning near the affected control
  when either threshold is missed.
- **Never block.** A future picker warns and then defers to the user. See
  [`principles.md`](principles.md) → Principle 3.

### Canonical palette verification

| Pair | Dark | Light | Result |
|---|---:|---:|---|
| `--accent-fg` on `--accent` | 5.11:1 | 5.11:1 | AA text |
| `--accent-fg` on `--accent-hover` | 4.60:1 | 4.60:1 | AA text |
| `--accent` focus indicator on `--surface-base` | 3.88:1 | 4.89:1 | WCAG non-text |
| `--accent` focus indicator on `--surface-card` | 3.54:1 | 5.11:1 | WCAG non-text |
| `--link` on `--surface-base` | 8.29:1 | 6.40:1 | AA text |
| `--link` on `--surface-card` | 7.57:1 | 6.68:1 | AA text |
| `--link-hover` on `--surface-base` | 11.27:1 | 8.40:1 | AA text |
| `--link-hover` on `--surface-card` | 10.30:1 | 8.76:1 | AA text |
| `--status-error-fg` on `--status-error-soft` | 8.46:1 | 5.55:1 | AA text |
| `--status-success-fg` on `--status-success-soft` | 8.60:1 | 6.43:1 | AA text |
| `--status-warning-fg` on `--status-warning-soft` | 9.47:1 | 6.33:1 | AA text |
| `--status-info-fg` on `--status-info-soft` | 8.87:1 | 6.89:1 | AA text |

Ratios use the WCAG relative-luminance formula and the canonical values in
`ui/theme.ts`; soft-fill ratios use the generated 12% sRGB mixture over
`--surface-card`.

## Theme override

- **Both light and dark**, with explicit override in Settings (matches
  Anthropic's monitor / sun / moon toggle). **System**
  (`prefers-color-scheme`) is the third option and the default.
- Theme is applied via `[data-theme="light"]` / `[data-theme="dark"]`
  on the root; only surface, text, and `--link*` keys override per
  theme. Numeric and structural tokens stay constant.

## Status colors

`--status-error`, `--status-success`, `--status-warning`,
`--status-info` (and their theme-specific `-fg` pairings) are declared in
`theme.ts` and generated into both `tokens.css` targets, available to every
desktop surface. Use a matching `-fg` token for text or icons on its `-soft`
fill; the light and dark values are independently contrast-verified. (They previously lived only in the standalone dashboard
stylesheet; the single-window redesign folded that surface into the
settings app.)
