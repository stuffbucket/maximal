# Failure modes — check these first

> **Scope.** The Tauri `shell/` design docs this file used to
> cross-reference (`aesthetic.md`, `change-checklists.md`, `color.md`,
> `components.md`, `keyboard.md`, `layout.md`, `motion.md`,
> `principles.md`, `tokens.md`, `type.md`, `windows.md`) described a
> theme system (`shell/src/ui/styles/theme.ts` and everything generated
> from it) that is being retired along with the Tauri shell. They have
> been deleted from the working tree — git history is the archive, not
> this directory. The Electron `client/` app instead consumes the
> `--shell-*` CSS custom-property contract published by
> `stuffbucket-electron`, which ships no palette or component styles by
> design. There is currently no equivalent design-system doc for
> `client/`; this file is trimmed to the failure modes that are
> genuinely implementation-agnostic, since the ones that referenced
> Tauri-specific tokens or components no longer have a home to point to.

If your output exhibits any of these patterns, stop and reconsider
before continuing.

## Accessibility

- **`:focus` instead of `:focus-visible`.** Focus rings should appear
  on keyboard navigation, not on mouse click. (Verified live in
  `client/src/renderer/workspace/RunCard.tsx` and `Inspector.tsx` — keep
  new interactive elements consistent with that pattern.)
- **Motion that ignores `prefers-reduced-motion: reduce`.** Reduced
  motion is a contract, not a hint — drop to opacity crossfades or
  instant transitions, don't just soften the animation.
- **Blocking the user on a contrast warning.** Warn, never block, when
  a user-chosen or theme-derived color combination drops below
  accessible contrast.

## Process

- **Editing `.design-context.md` instead of a topic file under
  `docs/design/`.** The front-door file is intentionally slim and is a
  pointer doc. Long-form content belongs in a topic file, not inflating
  the pointer.
