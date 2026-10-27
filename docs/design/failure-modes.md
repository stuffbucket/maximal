# Failure modes — check these first

If your output exhibits any of these patterns, **stop and re-read the
linked doc before continuing**. These are the things that keep
regressing across design iterations.

## Visual / structural

- **Page reads as a grid of similar rectangles ("AI dashboard").**
  Cards are being used as sectioning chrome. → [`aesthetic.md`](aesthetic.md)
  *When to use a card*. Squint test: if blurring reveals an even grid of
  rectangles, drop the cards.
- **Cards nested inside cards.** Forbidden. Collapse one level into a
  list-row or a typographic section.
- **A thick colored stripe down one edge of a box** (the "callout with a
  left border" look). It reads as generated UI. Callouts, conflicts and
  banners use a hairline border all round; a colored icon or title
  carries the tone. → [`components.md`](components.md) → *Callouts*.
- **Window has a visible H1 that duplicates the macOS titlebar text.**
  The H1 inside the content area is the *section* name, never the
  *window* name.
- **More than one Fraunces moment per window** (beyond the brand
  mark). Two display headings = the window has two competing
  identities; fix the IA, not the type. → [`type.md`](type.md).
- **Brand crimson on a button, focus ring, link, or active-nav
  affordance.** Brand is identity-only. Interactive surfaces are
  `--accent` (teal). → [`color.md`](color.md).
- **A fill color used as text.** `--accent` and `--accent-destructive`
  are fills: as text they miss 4.5:1 in at least one theme. Teal text
  is `--link`; error text and icons are `--status-error`.
- **`opacity` on text that isn't disabled.** It compounds with
  `--text-muted` and drops below AA. Disabled controls are exempt;
  everything else uses a token.

## Tokens & drift

- **Inline raw `px`, `rem`, or `#hex` in a component file *or in a
  design doc.*** Reference a token. If no suitable token exists, add
  one to `shell/src/ui/styles/theme.ts` (then `bun run
  tokens:generate`) and document it in [`tokens.md`](tokens.md) before
  using it. The one allowed exception is the drift table below, where
  the conflict is the point.
- **Editing a token value in only one place.** Edit
  `shell/src/ui/styles/theme.ts` and run `bun run tokens:generate`;
  never hand-edit the generated `tokens.css` or the Dashboard's
  generated region. See
  [`change-checklists.md`](change-checklists.md) → *Changing a token
  value* for the full touchpoint list.
- **Assuming the Dashboard has every token.** `tokens.css` and the
  Dashboard's generated region are both written from `theme.ts`, but the
  generator gives the Dashboard a subset (see the table below). A token
  missing from it is silently `inherit`-ed or `initial` in that window.

## Known active drift

Both token files are generated from `shell/src/ui/styles/theme.ts`
(`bun run tokens:generate`), so color values and both themes match. What
differs is which tokens each window gets:

| Concern | `shell/src/ui/styles/tokens.css` | `shell/ui/dashboard/style.css` |
|---|---|---|
| `--accent-destructive` / `-foreground` | present | absent (the generator omits them) |
| `--font-display` (Fraunces) | present | absent (intentional: no display moment) |
| Layout constants (`--sidebar-width`, `--content-max`) | present | absent (single-column window) |
| `--focus-ring-width` / `-offset` / `-color` | present; `--focus-ring` is an outline | absent; `--focus-ring` is a two-ring box-shadow |

Neither window pins `data-theme`; both follow the OS.

## Accessibility

- **`:focus` instead of `:focus-visible`.** Focus rings should appear
  on keyboard navigation, not on mouse click. → [`components.md`](components.md) →
  *Focus rings*.
- **Motion that ignores `prefers-reduced-motion: reduce`.** Reduced
  motion is a contract, not a hint. → [`motion.md`](motion.md).
- **Body text below `--text-base` for multi-line prose.** Never
  smaller. Settings descriptions can use `--text-sm`; body prose cannot.

## Keyboard / behavior

- **Re-binding `Cmd-K`.** It's reserved for the future command palette.
  Don't wire it to something else.
- **Implementing a binding that's already wired.** The keyboard table
  marks shipped vs. planned. → [`keyboard.md`](keyboard.md). Check
  before adding listeners.
- **Tooltips that scream the keybind** in all-caps or with heavy
  styling. Quiet parens: `Settings (⌘,)`.

## Process

- **Editing `.design-context.md` instead of `docs/design/*.md`.** The
  front-door file is intentionally slim and is a pointer doc. Long
  content goes in the topic files.
- **Adding a new token without a justification.** A token is a
  permanent commitment to a concept. Add the row in [`tokens.md`](tokens.md)
  *first*, then declare it in `theme.ts` and run `bun run
  tokens:generate`.
