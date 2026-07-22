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
- **Window has a visible H1 that duplicates the macOS titlebar text.**
  The H1 inside the content area is the *section* name, never the
  *window* name.
- **More than one Fraunces moment per window** (beyond the brand
  mark). Two display headings = the window has two competing
  identities; fix the IA, not the type. → [`type.md`](type.md).
- **Brand crimson on a button, focus ring, link, or active-nav
  affordance.** Brand is identity-only. Interactive surfaces are
  `--accent` (teal). → [`color.md`](color.md).

## Tokens & drift

- **Inline raw `px`, `rem`, or `#hex` in a component file *or in a
  design doc.*** Reference a token. Token *values* live in
  [`theme.ts`](../../shell/src/ui/styles/theme.ts) (the source of
  truth); `shell/src/ui/styles/tokens.css` is generated from it by
  `scripts/generate-css-tokens.ts`. If no suitable token exists, add
  it to `theme.ts`, regenerate, and document it in
  [`tokens.md`](tokens.md) before using it.
- **Hand-editing a generated file.** Never edit `tokens.css` directly
  — it is overwritten from `theme.ts`. Change the value in `theme.ts`
  and regenerate. See [`change-checklists.md`](change-checklists.md) →
  *Changing a token value*.
- **Re-inlining brand hex in a standalone surface.** `shell/splash.html`
  still hard-codes brand hex inline (it boots before any bundle loads),
  making it the last token-consuming surface not fed from `theme.ts`.
  Keep its `keep in sync` values matched to `theme.ts`, and prefer
  wiring it to the generator over adding a second inlined surface.
  Tracked in #352.

## Known active drift

_None._ The previously-tracked Settings ↔ Dashboard divergence (a
different teal, muted-text and border values, and a dark-only
dashboard) is resolved.

The single-window redesign ([#343]) removed the separate dashboard
surface and its hand-authored `shell/ui/dashboard/style.css`. The usage
view is now a React feature inside the settings app, styled from the
same generated `tokens.css`, so the two-file divergence the old audit
table tracked no longer exists — there is no second declaration site to
drift against.

The one remaining single-source gap is `shell/splash.html` (inlined
brand hex, above); CI enforcement of token freshness is tracked in
#352 / #354.

[#343]: https://github.com/stuffbucket/maximal/pull/343

## Accessibility

- **`:focus` instead of `:focus-visible`.** Focus rings should appear
  on keyboard navigation, not on mouse click. → [`components.md`](components.md) →
  *Focus rings*.
- **Motion that ignores `prefers-reduced-motion: reduce`.** Reduced
  motion is a contract, not a hint. → [`motion.md`](motion.md).
- **Blocking the user on a contrast warning.** Warn, never block. The
  user is in charge of their color. → [`color.md`](color.md).
- **Body text below `--text-base` (16px) for multi-line prose.** Never
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
  *first*, then declare in `tokens.css`.
