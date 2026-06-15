# Change checklists

Recipes for common design changes. Following the checklist costs a
minute; not following one is how the codebase ends up with two
different teals named `--accent` (see
[`failure-modes.md`](failure-modes.md) → *Known active drift*).

## Changing a token value

1. Edit `shell/src/tokens.css` (the declared ground truth).
2. **Also edit `src/pages/usage-viewer.css`** if the token is
   redeclared there. The Dashboard is a single embedded HTML file
   with no CSS imports — token declarations are independent. See
   [`windows.md`](windows.md) for why.
3. Update the value column in [`tokens.md`](tokens.md) if the value
   appears there.
4. Search for any inlined raw value the token was supposed to replace:
   `grep -rn '<old-value>' shell/src src/pages`.
5. Manually verify both windows: `bun run app:ui` for the Settings
   window, open the proxy and visit `/usage-viewer` for the Dashboard.
6. If the change is a color, re-check WCAG AA contrast on both
   surface levels per [`color.md`](color.md).

## Adding a new token

1. Confirm there isn't an existing token that fits. Check
   [`tokens.md`](tokens.md).
2. Add the row to [`tokens.md`](tokens.md) **first**, with `Purpose`,
   `Use for`, `Do NOT use for` filled in. A token without a clear
   role is a future drift source.
3. Declare in `shell/src/tokens.css` (and `usage-viewer.css` if the
   Dashboard needs it).
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

1. Read [`windows.md`](windows.md) → *Where they diverge*.
2. Decide: sidecar-served (single embedded HTML, like Dashboard) or
   Vite-bundled (like Settings)? The choice is architectural, not
   stylistic.
3. Add to the window-sizes table in [`layout.md`](layout.md).
4. Single-instance behavior: re-show + focus the existing window
   instead of opening another.
5. Position: center on first launch, then respect last position.
6. **If sidecar-served:** add a token-declaration block matching
   `tokens.css`. Mirror future token edits.

## Touching `.design-context.md` itself

That file is the slim front-door pointer. **Long content goes in the
topic files under `docs/design/*.md`.** If you're tempted to add more
than a paragraph to `.design-context.md`, you probably want to add a
section to a topic file and add a pointer in the front door instead.
