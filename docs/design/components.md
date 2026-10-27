# Components

Component dimensions, by token. These match the Settings stylesheet
(`shell/src/ui/styles/styles.css`); when a component fits an existing
pattern, match it exactly rather than hand-rolling something nearby.

Token values live in
[`shell/src/ui/styles/theme.ts`](../../shell/src/ui/styles/theme.ts);
token vocabulary in [`tokens.md`](tokens.md).

## Buttons

Every `.btn`: min-height `--size-xl`, padding `--space-2` ×
`--space-4`, `--text-sm` at `--weight-md`, `--radius-input`,
`--border-width-hairline` border.

| Variant | Class | Size | Notes |
|---------|-------|------|-------|
| Primary | `btn--primary` | base | `--accent-fg` on `--accent` fill |
| Secondary | `btn--secondary` | base | `--surface-control` fill, `--border-strong` border |
| Ghost | `btn--ghost` | base | Transparent, `--text-base-color`; hover → `--surface-control` |
| Ghost destructive | `btn--ghost-destructive` | base | Ghost that reads red; always confirms first |
| Icon | `btn--icon` | `--size-xl` square | `--size-sm` glyph centered; needs an `aria-label` |
| Small | `btn--sm` | min-height `--size-lg`, padding `--space-1` × `--space-3` | Sparingly; only in dense rows |
| Destructive | `btn--destructive` | base | `--accent-destructive-foreground` on `--accent-destructive` |

## Inputs

| Variant | Size | Notes |
|---------|------|-------|
| Text (`.input`) | min-height `--size-xl`, padding `--space-2` × `--space-3` | `--text-sm`; `--surface-control` fill, `--border-width-hairline` `--border-strong` border, `--radius-input` |
| Select (`.select`) | Same box as `.input` | Native chevron kept |
| Switch (`.switch`) | `--size-2xl` × `--size-lg` track, `--size-xs` thumb | `--accent` fill when on |
| Checkbox (`.checkbox`) | `--size-md` square, `--radius-chip` | `--accent` fill when checked; indeterminate shows a bar |

## Form rows

- Grid: 33% label column, remainder for the control, `--space-4` gap.
- Padding `--space-2` top and bottom, hairline `--border-subtle`
  divider between rows.
- Label `--text-sm` at `--weight-md`; hint `--text-sm` in
  `--text-muted`.
- Right-align controls only when they're visually right-anchored
  (toggles, dropdowns); left-align for text inputs.

## Sidebar (Settings)

- Width: `--sidebar-width`, fixed.
- Padding: `--space-3` vertical × `--space-2` horizontal; `--space-1`
  between items.
- Nav item: padding `--space-2` × `--space-3`, `--text-sm`,
  `--radius-input`. Weight `--weight-base` → `--weight-md` on active.
  **Active state: a `--surface-control` surface step** (not a left
  bar — left bar reads more dev-tool than humanist).
- No group labels; the nine sections are one flat list. The only
  uppercase text in the sidebar is the `.nav__chip` badge (see
  [`type.md`](type.md) → *Casing*).

## Cards

- Padding: `--space-4` vertical × `--space-5` horizontal. Nesting
  cards is forbidden — see [`aesthetic.md`](aesthetic.md).
- Internal row gap: `--space-3`.
- Background: `--surface-card`.
- Border: `--border-width-hairline` solid `--border-subtle`.
- Radius: `--radius-card`.
- Shadow: `--elevation-card` (barely visible on dark, where the
  surface step does the work).

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
naming the entity and a quiet `title` tooltip. A destructive one reads
red (`btn--ghost-destructive`) and always confirms in a `ConfirmDialog`
(`tone="danger"`) before acting.

## Focus rings

- **Always visible on keyboard navigation; hidden on mouse use** via
  `:focus-visible`. Using `:focus` alone is a bug. See
  [`failure-modes.md`](failure-modes.md).
- Settings: `outline: var(--focus-ring)` (width `--focus-ring-width`,
  color `--focus-ring-color` → `--accent`) with `outline-offset:
  var(--focus-ring-offset)`. `--accent` clears 3:1 on every surface of
  both themes, so there's no fallback color.
- Dashboard: `--focus-ring` is a two-ring box-shadow (a
  `--surface-base` gap, then `--accent`).
- **Identical ring on all focusable elements within a window** —
  buttons, inputs, switches, links, nav items. No special-case ring
  styles.

## Component dimensions (size tokens)

| Token | Use |
|---|---|
| `--size-xs` | Switch thumb, status dot |
| `--size-sm` | Glyph inside icon buttons and callouts |
| `--size-md` | Checkbox, inline status icons |
| `--size-lg` | Switch height, small-button min-height |
| `--size-xl` | Button and input min-height, icon-button square |
| `--size-2xl` | Switch width, narrow input |

## Border widths

| Token | Use |
|---|---|
| `--border-width-hairline` | Every border and divider: cards, inputs, buttons, callouts, sidebar edge |
| `--border-width-thin` | Same width as hairline; unused — reach for hairline |
| `--border-width-thick` | Emphasized strokes: the busy bar, the indeterminate checkbox bar, Dashboard sparklines |
| `--border-width-heavy` | Reserved; not currently used |
