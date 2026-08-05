# Principles & Decision Log

These bind all other design guidance. When in conflict with anything
else in `docs/design/` or any agent's intuition, **these win**.

## The five principles

1. **Speak to the person, not the file.** UI labels describe what the
   control does in human terms, not the underlying config field.
   "Sign in with GitHub" — not "Authenticate via OAuth device-code flow."
2. **Power lives in depth, not density.** Common controls are big,
   clear, and one click away. Advanced controls live one level down
   (collapsible sections, an "Advanced" tab, "Reveal in editor"
   escape hatch).
3. **Color is the user's, contrast is ours.** When user color controls ship,
   honor the chosen surface and icon colors while computing contrast for text
   and controls; warn (don't block) when a combination drops below WCAG AA.
   The current themes use the canonical verified palette. The brand mark stays
   brand-red in the dock and tray — that's identity, not preference.
4. **One humanist accent per window.** The brand "m" or a hand-drawn
   touch appears once per window — to remind the user it was made by
   a person, not on every row. Excess humanism is noise; rationed
   humanism is character.
5. **Reduced motion is a contract, not a hint.** When
   `prefers-reduced-motion: reduce` is set, animation drops to
   opacity crossfades or instant transitions. Hover scales,
   slide-ins, spring physics — all off. The setting is honored
   literally, not "with reduced intensity."

## Decision log (locked — do not revisit without cause)

Token names below; canonical values in [`ui/theme.ts`](../../ui/theme.ts).

- **Crimson `--brand` is brand only.** Rendered "m," hero moments,
  badging. Not for buttons, focus rings, or interactive states.
- **Warm bronze `--accent` is interactive.** Primary fill, focus ring,
  switch "on" state. Distinct from brand so neither role drowns the
  other.
- **Cool slate `--link` is distinct from both warm roles.** It shifts per
  theme to clear WCAG AA against both surface levels, so a primary button,
  identity mark, and inline prose link never read as the same affordance.
- **`--accent-destructive` is crimson-adjacent but NOT the same value
  as `--brand`** — a hair deeper, so it reads as "caution" rather
  than "identity."
- **The desktop titlebar is the window identifier.** Do not duplicate the
  app/window name as an in-content H1. Headings inside the content pane
  identify the current section or task.
- **Tray icons are colored** (not template) — 22pt viewBox, 44px @2x
  retina. Brand crimson reads on both light and dark menu bars and is
  the one place the brand is allowed to live outside the window.
- **Tray attention state:** white squircle, transparent "m" cutout,
  crimson dot. Single-glance affordance that doesn't get drowned by
  macOS's tinting.
- **Cards are for entities, not sectioning.** Page-level grouping is
  typography's job. See [`aesthetic.md`](aesthetic.md) → *When to
  use a card*.
- **Card nesting is forbidden.** Either the inner becomes a list-row
  inside the outer, or the outer becomes a typographic section.
- **No CSS responsive breakpoints in v1.** Desktop only; the OS
  enforces min sizes.
- **`Cmd-K` is reserved**, not bound. Don't repurpose it.
