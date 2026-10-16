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

## Callouts (banners)

A failure or notice is never a bare line of colored text. It's a
`Callout` (`shell/src/ui/components/Callout.tsx`; `.callout` classes for
vanilla markup) across the top of the section, or inside the card it's
about.

- Shape: icon, title, detail, at most **one** action (usually "Try
  again"), in a hairline-bordered box. **No colored edge stripe** — the
  thick left border is a stock generated-UI tell; the icon's color says
  the tone.
- Surface `--surface-control`, `--border-width-hairline` border,
  `--radius-card`, padding `--space-3` × `--space-4`.
- Tones: **error** (icon `--status-error`) when something failed;
  **notice** (icon `--text-muted`) when it's worth knowing but nothing is
  wrong. Not brand, not accent.
- Title says what happened in plain words ("Couldn't load your apps");
  detail carries the server's message; the action fixes it.
- A section's load error goes above its content, not after it.

### Problems (errors the user sees)

`ProblemCallout` + `describeProblem()` (`shell/src/ui/problems.ts`). The
rules, in order:

1. **Recover before reporting.** Loads retry transient failures
   (Maximal not answering, 429, 5xx) on their own via `withRetry`; only
   what's still wrong afterwards is shown. If Maximal is already fixing
   something (e.g. restarting the MCP broker), say so in one quiet
   `.panel-status` line — no banner, nothing to click — and poll.
2. **Name the cause in plain words.** "Maximal isn't responding", "You're
   not signed in to GitHub Copilot", "Maximal isn't allowed to change
   ~/.claude.json". Never internal names (broker, sidecar, circuit).
3. **One remedy, only if the user can do it**: Restart Maximal, Go to
   Account, or Try again (when they've fixed something, e.g. a file's
   permissions). Nothing they can do → no button; the detail says what
   happens next. Never two buttons for the same action — if the surface
   already has a Refresh, the banner doesn't add one.
4. **Raw error behind "Details"**, collapsed, for bug reports.
- Inline field validation (e.g. a name already taken) stays a caption
  next to the field.

## Empty states

Where a list will be, an `EmptyState` (`components/EmptyState.tsx`,
`.empty`) says what's missing and how to get it: a title ("No MCP
servers yet"), a sentence or two, and the one action that fills it if
the user can take it here. Dashed border, not a card — it holds no
entity. Don't show an empty state and an error at the same time; the
error wins.

## Checkbox groups with "All"

For one entity offered to several targets (an MCP server to each app):
an "All …" checkbox heads the group, the targets indent under it by
`--space-5`, rows split by a hairline. "All" shows the mixed
(indeterminate) state when some are checked. Each target row is a
`LinkCheckbox` (`components/LinkCheckbox.tsx`): checkbox + a label that
links to where the target is managed. The label never toggles the box
and always navigates. A target that can't be chosen right now shows a
warning glyph (`--status-warning`) **in place of** its checkbox — a box
would mean nothing there — with a tooltip saying why; the label greys
out but still links, and the stored choice is kept. No per-row status
text ("Added"): the tick says it. Anything worth saying about a row
after a save (e.g. the app already had its own entry) is a notice
`Callout` under the list. Changes save as made — no confirm step.

When the group only matters while the entity is on (an MCP server's
apps), the card is an accordion: a ghost icon button (`btn--icon`,
chevron-down, rotates 180° open) sits at the far right of the card head,
after the switch. Switching on opens it; switching off closes it and
disables the twirldown. While on, the twirldown folds the group away.
The button carries `aria-expanded` / `aria-controls`; the group is
`hidden` when closed, not just visually collapsed.

The card's other actions (an MCP server's Refresh and Remove) sit just left
of the switch as ghost icon buttons (`btn--icon`), each with an `aria-label`
naming the entity and a quiet `title` tooltip. A destructive one always
confirms in a `ConfirmDialog` (`tone="danger"`) before acting.

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
