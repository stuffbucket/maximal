# Components

This file is the single source of truth for component dimensions
that are **not** yet tokenized (button heights, input heights, sidebar
widths beyond `--sidebar-width`, etc.). Where a token exists, use it;
component CSS references the token, not the value. Where one doesn't
exist, this doc is canon — match the spec exactly rather than
hand-rolling something nearby.

Token values themselves live in
[`shell/src/tokens.css`](../../shell/src/tokens.css); token vocabulary
in [`tokens.md`](tokens.md).

## Buttons

| Variant | Height | Padding (h) | Font | Weight | Notes |
|---------|--------|-------------|------|--------|-------|
| Primary | 36 | 16 | `--text-sm` | 500 | `--accent-fg` on `--accent` fill |
| Secondary | 36 | 16 | `--text-sm` | 500 | `--border-width-thin` outline, transparent fill |
| Ghost | 32 | 12 | 13px | 500 | No outline; hover → `--surface-control` |
| Icon | 32×32 | — | — | — | 18px icon centered |
| Small | 28 | 12 | 13px | 500 | Sparingly; only in dense rows |
| Destructive | 36 | 16 | `--text-sm` | 500 | `--accent-destructive-foreground` on `--accent-destructive` |

## Inputs

| Variant | Height | Padding | Font | Notes |
|---------|--------|---------|------|-------|
| Text | 36 | 12 | `--text-sm` | `--border-width-thin` border, focus ring offset 2px |
| Textarea | min 96 | 12 | `--text-sm` | Resize vertical only |
| Select | 36 | 12 / 32 | `--text-sm` | Right-side chevron 16px |
| Switch | 24×16 | — | — | iOS-style; 200ms ease |
| Checkbox | 16×16 | — | — | 2px stroke |

## Form rows

- Min height: 48px (single-line label + control).
- Label column: ~210px on Settings, ~33% of content elsewhere.
- Control column: remainder. Right-align controls only when they're
  visually right-anchored (toggles, dropdowns); left-align for text
  inputs.

## Sidebar (Settings)

- Width: `--sidebar-width` (200px), fixed.
- Padding: 8px vertical, 4px horizontal.
- Nav item: 36px tall, 8px vertical padding, 12px horizontal.
  Weight 400 → 500 on active. **Active state: a 1px-rounded surface
  step** (not a left bar — left bar reads more dev-tool than
  humanist).
- Group label (e.g. "Desktop app"): 12px, 500, letter-spacing
  0.02em, uppercase, color = `--text-muted`. One per group, not on
  every item.

## Cards

- Padding: `--space-4` vertical × `--space-5` horizontal (16 × 20).
  One step tighter when nested inside a card (which should be rare —
  see card nesting rules in [`aesthetic.md`](aesthetic.md)).
- Gap between cards in a stack: `--space-4` (16).
- Internal row gap: `--space-3` (12, compact rows) or `--space-4`
  (16, form rows with their own labels).
- Background: `--surface-card`.
- Border: `--border-width-thin` solid `--border-subtle`.
- Radius: `--radius-card`.
- Shadow (light mode only): `--elevation-card`.

## Focus rings

- **Always visible on keyboard navigation; hidden on mouse use** via
  `:focus-visible`. Using `:focus` alone is a bug. See
  [`failure-modes.md`](failure-modes.md).
- Width: `--focus-ring-width` (2px). Offset: `--focus-ring-offset` (2px).
- Color: `--focus-ring-color` → `--accent`, with contrast fallback
  to `--text-strong` when accent on the current surface drops below
  3:1.
- **Identical ring on all focusable elements** — buttons, inputs,
  switches, links, nav items. No special-case ring styles.

## Component dimensions (size tokens)

| Token | Value | Use |
|---|---|---|
| `--size-xs` | 12px | Smallest icon |
| `--size-sm` | 16px | Default inline icon |
| `--size-md` | 20px | Button icon |
| `--size-lg` | 24px | Section icon |
| `--size-xl` | 32px | Icon button hit target |
| `--size-2xl` | 40px | Avatar / large icon |

## Border widths

| Token | Value | Use |
|---|---|---|
| `--border-width-hairline` | 1px | Subtle dividers |
| `--border-width-thin` | 1px | Card borders, input borders |
| `--border-width-thick` | 2px | Focus rings, emphasized dividers |
| `--border-width-heavy` | 4px | Reserved; not currently used |
