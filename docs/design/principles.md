# Principles & Decision Log

These bind all other design guidance. When in conflict with anything
else in `docs/design/` or any agent's intuition, **these win**.

## The five principles

1. **Speak to the person, not the file.** UI labels describe what the
   control does in human terms, not the underlying config field.
   "Sign in with GitHub" — not "Authenticate via OAuth device-code flow."
2. **Power lives in depth, not density.** Common controls are big,
   clear, and one click away. Advanced controls live one level down
   (collapsible sections, an "Advanced" tab, "Reveal in editor" escape
   hatch).
3. **Color is the user's, contrast is ours.** Honor user-chosen colors
   for surface and icon. Always compute and surface contrast for text
   and controls; warn (don't block) when a combination drops below
   WCAG AA. The brand mark stays the brand red in the dock and tray —
   that's identity, not preference.
4. **One humanist accent per window.** The brand "m" or a hand-drawn
   touch appears once per window — to remind the user it was made by
   a person, not on every row. Excess humanism is noise; rationed
   humanism is character.
5. **Reduced motion is a contract, not a hint.** When
   `prefers-reduced-motion: reduce` is set, animation drops to opacity
   crossfades or instant transitions. Hover scales, slide-ins, spring
   physics — all off. The setting is honored literally, not "with
   reduced intensity."

## Decision log (locked — do not revisit without cause)

- **Crimson is brand only.** `--brand: #c8334a` — rendered "m," hero
  moments, badging. Not for buttons, focus rings, or interactive
  states.
- **Teal is interactive.** `--accent: #5198a6` — primary fill, focus
  ring, switch "on" state.
- **Link tokens are a sister cool tone to accent.** Dark `#7fc1d2`
  (≥AAA against `--surface-base` and `--surface-card`). Light
  `#2d6470` (AA against both). Hover variants `#a8d8e3` / `#1e5560`.
- **`--accent-destructive: #b32d3f` is a hair deeper than `--brand`**
  so it reads as "caution," not "identity." It is **not** the same
  value as `--brand`.
- **Native macOS titlebar is the window identifier.** No duplicate
  in-window H1 of the window name. The H1 inside the content pane is
  the *section* name, not the window name.
- **Tray icons: 22pt viewBox, 44px @2x retina, colored** (not template
  icons). Brand crimson reads on both light and dark menu bars and is
  the one place the brand is allowed to live outside the window.
- **Attention state on the tray: white squircle, transparent "m"
  cutout, crimson dot.** A single-glance affordance for "the proxy
  wants your attention" that doesn't get drowned by macOS's tinting.
- **Cards are for entities, not sectioning.** A card represents one
  discrete actionable entity. Page-level grouping is typography's job.
  See [`aesthetic.md`](aesthetic.md) → *When to use a card*.
- **Card nesting is forbidden.** Either the inner becomes a list-row
  inside the outer, or the outer becomes a typographic section.
- **No CSS responsive breakpoints in v1.** Desktop only; the OS
  enforces min sizes.
- **`Cmd-K` is reserved**, not bound. Don't repurpose it.
