# Color

Four roles, deliberately split to keep each from flooding the surface.

| Token | Value | Role |
|---|---|---|
| `--brand` | `#c8334a` | Crimson. **Identity only.** Mark, hero, badging. |
| `--accent` | `#5198a6` | Teal. **Interactive surfaces.** Primary buttons, switches, focus rings, active nav. |
| `--accent-destructive` | `#b32d3f` | Crimson-adjacent. **Destructive actions only.** |
| `--link` | `#7fc1d2` dark / `#2d6470` light | Sister cool tone. **Prose links.** |

Foreground pairings: `--brand-fg`, `--accent-fg`,
`--accent-destructive-foreground` — always `#ffffff`.

## Why the split exists

The crimson was historically dual-purposed: brand mark *and* primary
button fill *and* focus ring. The effect was that every interactive
surface read as "brand" — so the brand stopped reading as anything
special, and the UI felt shouty.

Pulling interactive duty onto teal `--accent` recovered the brand
voice (it now appears once or twice per window, deliberately) while
giving interactions a calm, cooler tone that doesn't compete with
content.

## Destructive is not brand

`--accent-destructive` stays in the crimson family because
destructive actions want urgency, which is the one place the brand's
warning-red quality earns its keep. It is **not** the same value as
`--brand` (`#b32d3f` vs `#c8334a`) — destructive is a hair deeper so
it reads as "caution" rather than "identity."

## Link is sister to accent

`--link` is a *sister cool tone* to `--accent`: same teal family,
shifted lighter on dark / darker on light to clear WCAG AA against
both surface levels. Distinct enough from `--accent` that a primary
button (filled with accent) and an inline prose link don't read as
the same affordance.

Measured contrast (from `shell/src/tokens.css` notes):
- Dark `#7fc1d2` on `#0a0a0a` = 9.86, on `#161616` = 9.01
- Light `#2d6470` on `#fafafa` = 6.35, on `#ffffff` = 6.63

## Contrast contract

- **Target: WCAG AA (4.5:1)** across all colors, contrast, and focus
  rings. AAA where reachable without sacrificing the palette.
- **User-themable accent and surface colors.** Brand red is default;
  users can dial in their own UI color and icon color in Settings.
- **Contrast is ours.** When a user picks a combination whose
  body-text contrast drops below 4.5:1, surface a warning chip near
  the affected control.
- **Never block.** The user is in charge — be honest about the
  consequence, then defer to them. See
  [`principles.md`](principles.md) → Principle 3.
- The system computes contrast against `--surface-card` (where most
  text sits) and warns when text-on-card drops below WCAG AA.

## Theme override

- **Both light and dark**, with explicit override in Settings
  (matches Anthropic's monitor / sun / moon toggle). **System**
  (`prefers-color-scheme`) is the third option and the default.
- Theme is applied via `[data-theme="light"]` / `[data-theme="dark"]`
  on the root; only the surface and text keys (and `--link*`)
  override per theme. Numeric and structural tokens stay constant.

## Status colors

Currently declared in `src/pages/usage-viewer.css` only, not in
`tokens.css`:

- `--status-error` / `--status-error-fg`
- `--status-success` / `--status-success-fg`
- `--status-warning` / `--status-warning-fg`
- `--status-info` / `--status-info-fg`

If you need these in Settings, promote them into `tokens.css` first.
See [`change-checklists.md`](change-checklists.md).
