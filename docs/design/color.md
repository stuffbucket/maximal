# Color

Four roles, deliberately split to keep each from flooding the surface.
**Token values live in [`shell/src/ui/styles/theme.ts`](../../shell/src/ui/styles/theme.ts)**
(generated into `tokens.css`); the full list is in [`tokens.md`](tokens.md).
This file describes role, scope, and the reasoning behind the split.

| Token | Role |
|---|---|
| `--brand` | Crimson. **Identity only.** Mark, requirement stripe, tray dot. Never text or a control. |
| `--accent` | Teal. **Interactive fills and non-text.** Primary buttons, switches, checkboxes, focus rings. Never text. |
| `--accent-destructive` | Crimson-adjacent. **Destructive button fill only.** |
| `--link` | Teal text. **Every piece of teal text** — prose links, "Copied", accent figures. |

Errors are not destructive actions: error text, icons and stripes use
`--status-error`. Foreground pairings for fills: `--accent-fg`,
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
rather than "identity." It's a **fill**: white on it is 6.2:1, but as
text on a dark surface it's under 3:1, which is why error text uses
`--status-error` instead.

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
- With no attribute on the root the tokens follow the OS
  (`prefers-color-scheme`); `[data-theme="light"]` / `[data-theme="dark"]`
  on the root pins one. Surfaces, text, borders, `--link*`,
  `--accent` and `--status-*` change per theme; numeric and
  structural tokens, brand, and the button labels stay constant. See
  [`tokens.md`](tokens.md) → *Operational rules*. (The Settings toggle
  itself isn't built yet; until it is, both windows follow the OS.)

## Status colors

`--status-error`, `--status-success`, `--status-warning`,
`--status-info` are text-safe (≥4.5:1 on every surface of their theme),
so one token serves text, glyphs, bars and fills in that color.
They're per theme: the light values are darker steps of the same hues
so the warning amber, for example, stays legible on white. Use them for
state, never for identity or interaction — that's `--brand` / `--accent`.

## Color in data (Dashboard)

Color on the Dashboard only appears where it means something, and the
label beside it says what:

- **Meters** (quotas): the fill is the state — `--accent` while fine,
  `--status-warning` from 75% used, `--status-error` from 90%, with a
  warning icon at those levels so it never rests on color alone. The
  track is a pale step of the same color. Unlimited quotas have no meter.
- **Figures** (token totals, table cells) are text ink (`--text-strong`
  / `--text-base-color`); hierarchy comes from size. No per-category
  colors unless a chart with a legend ties each color to its category.
- **Status colors are for state only**, never to tell categories apart.
