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
- Connect to apps: a compact checkbox menu lists every app, summarizes the
  selected apps in its trigger (or names the connector when none are selected),
  and stays open while choices are changed. Apps
  that cannot receive the connector remain visible as disabled menu items with
  a warning glyph and an accessible reason. Changes save as made. The endpoint
  address and its Copy button sit below the menu.
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

## Rules

The fourth surface of the unified window, called Rules in the product (it was
Budget; the code, `budget-*` catalog keys and `/settings/api/budget` keep that
name). It lives in `shell/src/ui/features/budget/`, a React island in the
Settings bundle, and is reached at `#rules` (`#budget` and `/ui/budget/` still
redirect there). A rule is what the code calls a budget limit. One scrolling column: a one-line summary,
then three typographic sections, no cards: **Rules**, **Activity**,
**Settings**. Rules and Activity are what people open the window for, so they
come first. The first heading (Rules, `.section__title`) is the window's one
Fraunces moment; the others step down to Commissioner
(`.budget-block__title`). The window's own name is in the native title bar, so
no heading repeats it.

- **Summary.** One line (`.budget-status`) above the Rules heading: whether
  rules are enforced, how many exist, and how far the rule a request would hit
  first (else the widest) has got, e.g. "Enforcing · 2 rules · $12.40 of $100
  today". It is muted while enforcement is off. A spent blocking rule, a missing
  usage database and a status that failed to load each show under it as a notice
  `Callout` or `ProblemCallout`.
- **Rules.** A hairline-divided list (`.limits`), one row per rule that exists,
  in the server's order (widest scope first, so a row never jumps as spend
  changes). A row is the name (with a `.chip` for its scope when it has a name of
  its own, and a "Warn only" chip), edit and delete as ghost icon buttons, a
  meter, then the figures: confirmed spend ("$12.40 of $100"), the state (icon
  and word, for nearly spent and spent), what is left, what is held by calls in
  progress, any conservative amount awaiting reconciliation, and when it resets.
  Every figure uses the rule's unit, so token rules show token counts rather than
  currency. The meter and amount left include unreconciled spend, so they remain conservative
  even though the primary figure separates it. The meter (`.budget-meter`) is the Dashboard's quota meter: the
  fill is `--accent` while fine, `--status-warning` from the rule's own warn
  threshold, `--status-error` once spent; the track is a pale step of the same
  color. No rule exists until someone adds it, so the empty state is an
  `EmptyState` with "Add a rule"; there are never per-model rows.
- **Rules from sessions.** Beside "Add a rule" (a quiet ghost button,
  `.budget-block__actions`) sits "Create rules from sessions", which opens a native
  `<dialog>` in the editor's shell (`.budget-sessions`) with two steps. *Pick*: a
  `RangePicker` and the sessions in it (`GET .../sessions`, biggest spender first,
  twelve shown, "Show all" for the rest), each row a checkbox label: the client or key,
  when it started (UTC), its requests and minutes, its model mix as text ("claude-sonnet
  62%, claude-opus 30%, and 2 more") and its cost. Picks survive a change of range
  (a line says how many sit outside the one shown); none picked means all usage in the
  range, which the button says. A select chooses the shape of the rules (Let Maximal
  choose, Trying things out, Daily driver, Heavy agent use, Team; their amounts always
  come from what was picked). *Review*: the suggestion (`POST .../suggest`) as a
  hairline-divided list (`.draft`): the rule's name, scope chip and amount with its
  reset, what it would have done to the usage it was sized from ("Over 36 periods it
  would have been reached in 4 and refused 573 requests ($2.49)"), how the amount was
  reached, and two actions: **Open in editor** (the editor opens over the dialog,
  filled in, with its What if; a draft whose reset the editor cannot set yet, such as a
  rolling one, can only be added) and **Add rule** (the row then says Added and stays).
  "Add all N" adds the rest and stops at the first that fails, whose row says why.
  `short_history` and `no_spend` notes are notices. Nothing picked or suggested is lost
  to a stray click: once something is picked the backdrop and Escape do nothing and
  Cancel or Done is the way out, as in the editor.
- **Rules for one model.** The Models list marks a model with a shield-check (the glyph
  of the Rules surface in the top bar, `.model-row__rules`, a link) when a rule names
  it: a filter of models with a member (exact id or glob) that matches, or the model's
  provider. A rule that covers everything is not marked on every row, since it would
  say nothing about any one of them: the list says once, above the models, how many
  cover everything, with a link to Rules. The shield opens `#rules/model/<id>` (the id
  escaped), and Rules, which follows its address, lists every rule that applies to that
  model, including those that cover everything, under a chip ("Showing rules for
  gpt-6.1-sol", with how many of the rules it is) whose × (or `#rules`) clears it. A
  model no rule applies to says so under the chip.
- **How a rule is performing.** Each row carries a sparkline (`.spark`, the last
  seven days' spend, one line in `--series-1`, no axes) in a quiet button
  (`.limit__perf`, `aria-expanded`, a chevron beside it) that opens the rule's
  history inline under its row, as a disclosure rather than a panel or a second
  page: depth on demand, the list keeps its place. Any number of rows may be
  open. The detail (`.rule-detail`) is a range picker (default 30 days, the same
  `RangePicker` Activity uses), four totals in the Dashboard's totals style (spent,
  requests, periods crossed, requests refused with what they would have cost), the
  timeline, a three-item legend with counts, and a table of the periods (newest
  first, five rows, "Show all"; an estimated period wears an "est." chip). The
  timeline (`.timeline`) places everything on one time axis: spend counted in each
  period climbing toward the limit (`--series-1` line and pale area, starting over
  where a period resets, which is also a dotted `--border-strong` line), the limit
  as a solid `--status-error` line and the warning as a dashed `--status-warning`
  line, each labelled at the right edge ("Limit $40.50", "Warns at $32.40"), and
  under it the spend per bucket as columns on their own scale. Markers sit on the
  line they belong to and differ by shape as well as hue: a triangle warned, a dot
  reached the limit, a cross is a refused request (one per bucket, its count and
  cost in the tooltip). The plot is an image to a screen reader with the figures in
  its label; the legend and the periods table carry them in text. It follows the
  same states as Activity: the previous figures stay while the next range loads, a
  failed load drops them and shows a retry, a range with nothing counted is a
  compact `EmptyState`.
- **Add or edit a rule.** A native `<dialog>` in `.confirm-dialog`'s shell
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
  on either. Under the fields sits a **What if** panel (`.whatif`, a hairline above it, in the
  dialog's scroll area): a range picker (7 days, 30 days, 90 days, All time; 30 days
  to start) and the rule as typed, replayed over recorded usage once typing has
  paused (`POST .../simulate`, nothing is applied). It lists when the rule would
  have warned and reached its limit, the requests it would have refused and what
  they cost (a rule that only warns says so), the most spent in one period (one
  window, for a rolling rule), the requests it covers and the periods that hit the
  limit, then "Suggested: $X" (the amount that would have kept about nine in ten
  periods under the limit, rounded up to what it reads as) with a "Use $X" button
  that puts it in the amount field and nothing else. It never changes what was
  typed, the name is not part of the question (typing it asks for nothing), a form
  that isn't a rule yet shows what it needs, a replay that fails shows an error
  with a retry and leaves Save as it was, and the previous answer stays up
  (labelled "Updating…") while the next one loads. Deleting asks in a `ConfirmDialog`.
- **Activity.** What was used, over any range, laid out like the Dashboard. A
  range picker (`.range-seg`, a segmented row: 24 hours, 7 days, 30 days, 90 days,
  All time, Custom; the chosen option steps forward onto the card surface, as in
  the permission control) and a group select (model, plugin, client key, provider,
  day, hour). Custom opens two day fields (UTC, the second day included); a range
  that runs backwards says so under them and fetches nothing. The shared
  `RangePicker` and `range.ts` also serve a rule's timeline and the what-if
  preview. Then a totals strip (`.budget-totals`, hairlines above and below, not a
  card) in the Dashboard's measures and its catalog labels: total tokens as the
  headline, then input, output, cache read, cache write, requests and cost. Then a chart and a
  table of the same rows with the same measures per row (token counts compact, the
  exact figure in the cell's tooltip), and a "Download activity statement (CSV)"
  button (the shell's save dialog; a plain download in a browser) whose tooltip and
  file name (`maximal-activity-<range>-by-<group>.csv`, the range being `7d` or
  `2026-11-01_to_2026-11-08`) name the range and grouping. A group that used nothing
  is still listed (`include_free`), so the rows add up to the totals, as on the
  Dashboard. By model, plugin, client key or provider the chart is a thin segmented
  bar (`.budget-share`): five parts in `--series-1` to `--series-5`, the tail folded
  into a neutral "Other", and a swatch on each table row standing in for a legend. By
  day or hour it is columns (`.budget-columns`, at most `--size-lg` wide,
  `--radius-chip` rounded tops, one baseline) on an even time axis, quiet buckets
  drawn empty; a long span packs its columns closer (`--dense`, `--packed`), and the
  first and last bucket and the busiest are named under them. The chart never
  carries a number the table doesn't. A table longer than ten rows folds under "Show
  all" (newest first for a span of time, the biggest spender first otherwise, at most
  500 rows; the statement has the rest). The table is seven columns in a 640px window
  with tight cells and headings that wrap (a long German compound breaks inside its
  column) rather than an inner scroller. While another range loads the previous
  figures stay (`aria-busy`); a failed load drops them, so a range's figures never
  sit under another's heading, and shows an error `ProblemCallout` with a retry; a
  range with nothing recorded is an `EmptyState` that suggests a longer one.

- **Settings.** Two `.form` rows (an on/off `Switch` for enforcement, a `.select`
  for the display unit), then what each provider reports: its allowances grouped
  under the provider's name, each a label, the percent used, a meter and
  "Resets <date> (<relative>)". These are the provider's figures and can lag, so
  the section says so; rules count what Maximal records.

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
