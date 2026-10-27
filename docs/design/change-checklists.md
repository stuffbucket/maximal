# Change checklists

Recipes for common design changes. Following the checklist costs a
minute; not following one is how a value ends up hand-edited in a
generated file or inlined where a token belongs (see
[`failure-modes.md`](failure-modes.md)).

## Token value hygiene (read first)

- **Values live in `shell/src/ui/styles/theme.ts` only.** Design docs reference
  tokens by name + purpose, never by value. The only allowed exception
  is [`failure-modes.md`](failure-modes.md)'s drift audit table.
- If a doc shows a value, that's a bug — fix the doc.
- If you change a value, follow *Changing a token value* below.

## Changing a token value

1. Edit `shell/src/ui/styles/theme.ts` (the declared ground truth). A
   color that differs between light and dark goes in **both**
   `themes.dark` and `themes.light`.
2. Run `bun run tokens:generate`. It rewrites `shell/src/ui/styles/tokens.css`
   and the generated region of `shell/ui/dashboard/style.css` (the
   Dashboard's stylesheet isn't bundled with Settings', so it carries
   its own generated copy — see [`windows.md`](windows.md)). Never
   hand-edit either.
3. Search for any inlined raw value the token was supposed to replace:
   `grep -rn '<old-value>' shell/src shell/ui shell/splash.html`. The
   splash window inlines `--brand` by hand (it loads before any
   stylesheet), so a brand change goes there too.
4. Manually verify both windows: `bun run app:ui` with the proxy
   running, then open `http://localhost:4141/ui/settings/` and
   `/ui/dashboard/`.
5. If the change is a color, run `bun run storybook:check` (includes
   the contrast audit across all three surfaces in **both** themes) per
   [`color.md`](color.md). Storybook's Theme toolbar (System / Dark /
   Light) is the quickest way to look.

## Adding a new token

1. Confirm there isn't an existing token that fits. Check
   [`tokens.md`](tokens.md).
2. Add the row to [`tokens.md`](tokens.md) **first**, with `Purpose`,
   `Use for`, `Do NOT use for` filled in. A token without a clear
   role is a future drift source.
3. Declare it in `shell/src/ui/styles/theme.ts` and run `bun run
   tokens:generate`. If the Dashboard needs a token the generator
   doesn't give it (see [`failure-modes.md`](failure-modes.md) →
   *Known active drift*), extend the Dashboard branch of
   `scripts/generate-css-tokens.ts`.
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
   `--focus-ring` composed token (see [`components.md`](components.md)
   → *Focus rings*).
5. Hover/active transitions: 150ms ease-out. Wrap in the global
   reduced-motion block ([`motion.md`](motion.md)).
6. Add stories under `packages/storybook/src/` covering each visual
   state (not just the happy path). Check them in both themes.

## Adding or modifying a color role

1. Read [`color.md`](color.md) → *Why the split exists*. The four
   roles (brand, accent, destructive, link) earn their separation;
   don't collapse them.
2. If proposing a new role (e.g. a fifth color), justify it against
   the existing four. If "I want a different teal for X" is the
   reason, the answer is probably "use `--accent`."
3. Pick values that pass on all three surfaces in both themes (WCAG
   AA: 4.5:1 for text, 3:1 for controls). A color that must work as
   text and as a fill should pass as text on its own; don't add a
   separate foreground-pairing token.
4. Add the tokens to `theme.ts` (both `themes.dark` and
   `themes.light` if they differ per theme), run `bun run
   tokens:generate`, then `bun run storybook:check`.
5. Update [`tokens.md`](tokens.md) and [`color.md`](color.md).

## Wiring a keyboard binding

1. Check [`keyboard.md`](keyboard.md) — confirm the binding isn't
   already **shipped** (don't duplicate) or **reserved** (don't
   repurpose, especially `Cmd-K`).
2. Choose scope:
   - **Tray menu** → an accelerator on the tray `MenuItem` in
     `build_menu` (`shell/src-tauri/src/lib.rs`).
   - **Per-window** → `keydown` listener in the window's frontend
     code (`shell/src/` or `shell/src/dashboard/`).
3. Cross-platform: `event.metaKey || event.ctrlKey`.
4. Add the tooltip affordance on the corresponding visible control,
   keybind in parens: `Settings (⌘,)`.
5. Update [`keyboard.md`](keyboard.md) status: `planned` → `shipped`.

## Adding a window

1. Read [`windows.md`](windows.md) → *Where they diverge*.
2. Add the window builder in `shell/src-tauri/src/lib.rs` and a build
   step in `scripts/build-ui.ts` so the proxy serves it under `/ui/`.
3. Add to the window-sizes table in [`layout.md`](layout.md).
4. Single-instance behavior: re-show + focus the existing window
   instead of opening another; closing hides it.
5. Tokens: import the generated `tokens.css`, or give the window its
   own generated region in `scripts/generate-css-tokens.ts`. Never
   hand-declare token values.

## Touching `.design-context.md` itself

That file is the slim front-door pointer. **Long content goes in the
topic files under `docs/design/*.md`.** If you're tempted to add more
than a paragraph to `.design-context.md`, you probably want to add a
section to a topic file and add a pointer in the front door instead.
