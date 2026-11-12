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
   something (e.g. a plugin still starting), say so in one quiet
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
`.empty`) says what's missing and how to get it: a title ("No connectors
available"), a sentence or two, and the one action that fills it if
the user can take it here. Dashed border, not a card — it holds no
entity. Don't show an empty state and an error at the same time; the
error wins.

## Checkbox groups with "All"

For one entity offered to several targets (a plugin to each app):
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

When the group only matters while the entity is on (a plugin's
apps), the card is an accordion: a ghost icon button (`btn--icon`,
chevron-down, rotates 180° open) sits at the far right of the card head,
after the switch. Switching on opens it; switching off closes it and
disables the twirldown. While on, the twirldown folds the group away.
The button carries `aria-expanded` / `aria-controls`; the group is
`hidden` when closed, not just visually collapsed.

The card's other actions (e.g. Refresh or Remove) sit just left
of the switch as ghost icon buttons (`btn--icon`), each with an `aria-label`
naming the entity and a quiet `title` tooltip. A destructive one reads
red (`btn--ghost-destructive`) and always confirms in a `ConfirmDialog`
(`tone="danger"`) before acting.

## Connectors

Settings → Integrations → Connectors (`shell/src/ui/features/connectors/`).

**List.** A `.table` with Connector (glyph tile + name), Type ("Built-in"
or "Plugin") and Status columns. The name is the row's button (the Tab
stop; Enter opens), and a click anywhere on the row opens it too. Status
is a tick (`--status-success`, named for screen readers) when the
connector is ready, else a `.connector-dot` in a status token plus a
short word (Off, Needs setup, Signing in, Starting, Error, Failed), and a
quiet chevron.

**Page.** Opening a row replaces the list in place (`#connectors/<id>`,
mirrored with `replaceState`); "← Your connectors" goes back and returns
focus to the row. Opening from the list moves focus to the page's heading.
No cards: the page is the entity, laid out as hairline-divided
typographic sections:

- Head: tile, name, on/off switch; then the description and the
  connector's own report — status line, detail, facts (`.kv`), action
  buttons. The connector's `kind` of action picks the button (primary,
  secondary, or destructive as a ghost that reads red); an action with
  `confirm` asks in a `ConfirmDialog` first. One that failed to start
  shows an error `Callout` instead. Off shows no status line.
- Connect to apps: a `LinkCheckbox` per client and the endpoint address
  with a Copy button.
- Tool permissions: the tools in three groups (Read-only, Write/delete,
  Other), each a twirl with a `.count-badge` and a menu button (Always
  allow / Ask every time / Blocked set the whole group; Custom marks a mixed
  group, checked and never an action). A tool row has its title, a
  three-state `.perm-seg` radio group (Allowed / Asks / Blocked: glyph-only,
  so each option has a name and a tooltip; arrow keys move and choose; a
  chosen Asks reads in `--status-warning`), its description
  clamped to two lines with Show more, and twirls for its inputs and,
  nested, its full input schema (`--code-block-max`, scrolls inside).
  Changes save as made and show at once; a failed save puts the control
  back and says why in a `ProblemCallout`. Tools from the cached catalog
  carry a quiet `.panel-status` line saying when they were last seen.
- Configuration: a `.form` generated from the connector's config schema;
  advanced fields fold under a twirl (open when the connector failed to
  start). Save / Revert; the connector's validation lands as a caption
  under the field it names.
- About: where it connects, how it signs in, its terms and website.

Text a connector supplies is shown as written; only http(s) addresses in
it become links, opened in the system browser. Glyphs are Maximal's own
(`glyphs.tsx`).

## Budget

The fourth surface of the unified window (`shell/src/ui/features/budget/`, a
React island in the Settings bundle). One scrolling column: a one-line summary,
then three typographic sections, no cards: **Limits**, **Activity**,
**Settings**. Limits and Activity are what people open the window for, so they
come first. The first heading (Limits, `.section__title`) is the window's one
Fraunces moment; the others step down to Commissioner
(`.budget-block__title`). The window's own name is in the native title bar, so
no heading repeats it.

- **Summary.** One line (`.budget-status`) above the Limits heading: whether
  limits are enforced, how many exist, and how far the limit a request would hit
  first (else the widest) has got, e.g. "Enforcing · 2 limits · $12.40 of $100
  today". It is muted while enforcement is off. A spent blocking limit, a missing
  usage database and a status that failed to load each show under it as a notice
  `Callout` or `ProblemCallout`.
- **Limits.** A hairline-divided list (`.limits`), one row per limit that exists,
  in the server's order (widest scope first, so a row never jumps as spend
  changes). A row is the name (with a `.chip` for its scope when it has a name of
  its own, and a "Warn only" chip), edit and delete as ghost icon buttons, a
  meter, then the figures: ".40 of .00", the state (icon and word, for
  nearly spent and spent), what is left, what is held by calls in progress, and
  when it resets. The meter (`.budget-meter`) is the Dashboard's quota meter: the
  fill is `--accent` while fine, `--status-warning` from the limit's own warn
  threshold, `--status-error` once spent; the track is a pale step of the same
  color. No limit exists until someone adds it, so the empty state is an
  `EmptyState` with "Add a limit"; there are never per-model rows.
- **Add or edit a limit.** A native `<dialog>` in `.confirm-dialog`'s shell
  (`.budget-editor`): name, what it applies to (everything, one client key, one
  plugin, one provider, listing only what exists), amount in the display unit,
  warn-at percent, when it resets (with each window the provider reported, else
  daily, weekly or never) and whether reaching it refuses requests or only warns.
  The amount field (`.input-adorn`) shows its unit inside it (`$` on the side the
  locale writes it, or "credits" after) so nobody has to type it. Typing is
  forgiving: a currency sign or code ("$100", "100 USD"), a credit word ("100
  credits", "AIU", "cr"), spaces and the locale's thousands separators all read,
  and a unit other than the display unit is converted at the status's
  `credit_usd` (`parseAmountDetailed` in `format.ts`). A validation problem is a
  caption under its field that says what is wrong ("Enter an amount like 100 or
  $100"; zero has its own wording), focuses the field and keeps the dialog and
  every value as they were; a refused save is an error `Callout` inside the
  dialog. **Edits are never discarded by accident:** while the form differs from
  what it opened with, a click on the backdrop (or in the dialog's padding) and
  Escape do nothing, and Cancel is the explicit way out. An untouched form closes
  on either. Deleting asks in a `ConfirmDialog`.
- **Activity.** Period and group pickers, the period's total, a chart, a table of
  the same rows and a "Download activity statement (CSV)" button (the shell's
  save dialog; a plain download in a browser) whose tooltip and file name
  (`maximal-activity-<period>-by-<group>.csv`) name the period and grouping. By model, plugin, client key or provider the chart is a
  thin segmented bar (`.budget-share`): five parts in `--series-1` to
  `--series-5`, the tail folded into a neutral "Other", and a swatch on each
  table row standing in for a legend. By day it is columns (`.budget-columns`, at
  most `--size-lg` wide, `--radius-chip` rounded tops, one baseline) with the busiest
  day labelled. The chart never carries a number the table doesn't, and rows that
  spent nothing are not listed. A table longer than ten rows folds under "Show all".

- **Settings.** Two `.form` rows (an on/off `Switch` for enforcement, a `.select`
  for the display unit), then what each provider reports: its allowances grouped
  under the provider's name, each a label, the percent used, a meter and
  "Resets <date> (<relative>)". These are the provider's figures and can lag, so
  the section says so; limits count what Maximal records.

All text is in the catalog (`budget-*` keys); amounts and dates go through `Intl`
in the active locale, with the unit passed as an ICU argument.

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
| `--border-width-thick` | Emphasized strokes: the busy bar and the indeterminate checkbox bar |
| `--border-width-heavy` | Reserved; not currently used |
