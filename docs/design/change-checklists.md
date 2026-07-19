# Change checklists

Recipes for common design changes. Following the checklist costs a
minute; not following one is how the codebase used to end up with two
different teals named `--accent`. Token values are now single-sourced
from [`theme.ts`](../../shell/src/ui/styles/theme.ts), which closes
that gap — keep it closed by editing the source, never the generated
CSS.

## Token value hygiene (read first)

- **Values are sourced from `shell/src/ui/styles/theme.ts` only** and
  generated into `shell/src/ui/styles/tokens.css`. Design docs
  reference tokens by name + purpose, never by value.
- If a doc shows a value, that's a bug — fix the doc.
- If you change a value, follow *Changing a token value* below.

## Changing a token value

1. Edit the value in
   [`shell/src/ui/styles/theme.ts`](../../shell/src/ui/styles/theme.ts)
   (the source of truth).
2. Regenerate the CSS: `bun run scripts/generate-css-tokens.ts`. Never
   hand-edit `tokens.css` — it is overwritten.
3. Update the value column in [`tokens.md`](tokens.md) if the value
   appears there.
4. Search for any inlined raw value the token was supposed to replace:
   `grep -rn '<old-value>' shell/src shell/splash.html`.
5. Manually verify the app: `bun run app:ui`.
6. If the change is a color, re-check WCAG AA contrast on both
   surface levels per [`color.md`](color.md).

## Adding a new token

1. Confirm there isn't an existing token that fits. Check
   [`tokens.md`](tokens.md).
2. Add the row to [`tokens.md`](tokens.md) **first**, with `Purpose`,
   `Use for`, `Do NOT use for` filled in. A token without a clear
   role is a future drift source.
3. Declare it in [`theme.ts`](../../shell/src/ui/styles/theme.ts) and
   regenerate (`bun run scripts/generate-css-tokens.ts`).
4. Use it. Don't inline the value anywhere else.

## Adding a new component

1. Read [`aesthetic.md`](aesthetic.md) → *When to use a card* before
   reaching for card chrome. Most "new components" should be
   typography + spacing.
2. Reference [`components.md`](components.md) for existing dimensions
   (heights, padding, fonts). If the component fits an existing
   pattern, match it exactly; novelty costs visual cohesion.
3. All measurements: token references only. No inline `px`/`rem`/`#hex`.
4. Focus ring: `:focus-visible`, never `:focus`. Use the
   `--focus-ring` composed token.
5. Hover/active transitions: 150ms ease-out. Wrap in the global
   reduced-motion block ([`motion.md`](motion.md)).

## Adding or modifying a color role

1. Read [`color.md`](color.md) → *Why the split exists*. The four
   roles (brand, accent, destructive, link) earn their separation;
   don't collapse them.
2. If proposing a new role (e.g. a fifth color), justify it against
   the existing four. If "I want a different teal for X" is the
   reason, the answer is probably "use `--accent`."
3. Measure contrast against both `--surface-base` and `--surface-card`
   in both themes. Target WCAG AA (4.5:1).
4. Add tokens + foreground pairing (`--<name>-fg`).
5. Update [`tokens.md`](tokens.md) and [`color.md`](color.md).

## Wiring a keyboard binding

1. Check [`keyboard.md`](keyboard.md) — confirm the binding isn't
   already **shipped** (don't duplicate) or **reserved** (don't
   repurpose, especially `Cmd-K`).
2. Choose scope:
   - **Global (tray-active)** → `tauri-plugin-global-shortcut` in
     `shell/src-tauri/`.
   - **Per-window** → `keydown` listener in the Vite frontend.
3. Cross-platform: `event.metaKey || event.ctrlKey`.
4. Add the tooltip affordance on the corresponding visible control,
   keybind in parens: `Settings (⌘,)`.
5. Update [`keyboard.md`](keyboard.md) status: `planned` → `shipped`.

## Adding a window

1. Read [`windows.md`](windows.md).
2. Decide: standalone embedded HTML (boots before any bundle, like
   `splash.html`) or part of the Vite-bundled app (like Settings)? The
   choice is architectural, not stylistic. Prefer the bundled app so
   the surface inherits the generated `tokens.css` for free.
3. Add to the window-sizes table in [`layout.md`](layout.md).
4. Single-instance behavior: re-show + focus the existing window
   instead of opening another.
5. Position: center on first launch, then respect last position.
6. **If standalone embedded HTML:** it can't import `tokens.css`, so
   any inlined brand hex must be kept in sync with `theme.ts` by hand
   (this is the `splash.html` gap tracked in #352). Avoid adding a
   second such surface if the bundled app can serve the need.

## Touching `.design-context.md` itself

That file is the slim front-door pointer. **Long content goes in the
topic files under `docs/design/*.md`.** If you're tempted to add more
than a paragraph to `.design-context.md`, you probably want to add a
section to a topic file and add a pointer in the front door instead.
