# Color

Four roles, deliberately split to keep each from flooding the surface.
**Token values are sourced from
[`shell/src/ui/styles/theme.ts`](../../shell/src/ui/styles/theme.ts)**
and generated into `shell/src/ui/styles/tokens.css`.
This file describes role, scope, and the reasoning behind the split.

| Token | Role |
|---|---|
| `--brand` | Crimson. **Identity only.** Mark, hero, badging, attention-state tray dot. |
| `--accent` | Teal. **Interactive surfaces.** Primary buttons, switches, focus rings, active nav. |
| `--accent-destructive` | Crimson-adjacent. **Destructive actions only.** |
| `--link` | Sister cool tone to `--accent`. **Prose links only.** |

Foreground pairings: `--brand-fg`, `--accent-fg`,
`--accent-destructive-foreground`.

## Why the split exists

The crimson was historically dual-purposed: brand mark *and* primary
button fill *and* focus ring. Every interactive surface read as
"brand" — so the brand stopped reading as anything special, and the
UI felt shouty.

Pulling interactive duty onto teal `--accent` recovered the brand
voice (it now appears once or twice per window, deliberately) while
giving interactions a calm, cooler tone that doesn't compete with
content.

## Destructive is not brand

`--accent-destructive` stays in the crimson family because
destructive actions want urgency, which is the one place the brand's
warning-red quality earns its keep. It is **not** the same value as
`--brand` — destructive is a hair deeper so it reads as "caution"
rather than "identity."

## Link is sister to accent

`--link` and `--link-hover` share `--accent`'s teal family but shift
lighter on dark / darker on light so each theme clears WCAG AA
against both `--surface-base` and `--surface-card`. Distinct enough
from `--accent` that a primary button (accent-filled) and an inline
prose link don't read as the same affordance.

Measured contrast on the current values is recorded in the comment
block above `--link` in `tokens.css`. Re-measure if you change either.

## Contrast contract

- **Target: WCAG AA (4.5:1)** across all colors, contrast, and focus
  rings. AAA where reachable without sacrificing the palette.
- **User-themable accent and surface colors.** Brand red is default;
  users dial in their own UI color and icon color in Settings.
- **Contrast is ours.** When a user picks a combination whose
  body-text contrast drops below 4.5:1, surface a warning chip near
  the affected control.
- **Never block.** The user is in charge — be honest about the
  consequence, then defer to them. See
  [`principles.md`](principles.md) → Principle 3.
- The system computes contrast against `--surface-card` (where most
  text sits) and warns when text-on-card drops below WCAG AA.

## Theme override

- **Both light and dark**, with explicit override in Settings (matches
  Anthropic's monitor / sun / moon toggle). **System**
  (`prefers-color-scheme`) is the third option and the default.
- Theme is applied via `[data-theme="light"]` / `[data-theme="dark"]`
  on the root; only surface, text, and `--link*` keys override per
  theme. Numeric and structural tokens stay constant.

## Status colors

`--status-error`, `--status-success`, `--status-warning`,
`--status-info` (and their `-fg` pairings) are declared in `theme.ts`
(`status`) and generated into `tokens.css`, available to every shell
surface. (They previously lived only in the standalone dashboard
stylesheet; the single-window redesign folded that surface into the
settings app.)
