/*
 * The `--shell-*` palette.
 *
 * `stuffbucket-electron/renderer/styles.css` ships no palette by design (see
 * its own header comment) — a host defines the semantic custom properties
 * documented in that package's README before importing the stylesheet.
 * `client/` is that host and, until this file, defined none: every author of
 * `workspace/`, `dashboard/`, `settings/` and `first-run/` was disciplined
 * inside their own file (every `var()` read there carries a literal
 * fallback), but nobody was assigned "define the tokens themselves." This
 * module is that assignment — one `:root` block, imported once from
 * `main.tsx` before anything mounts, so every surface (including the
 * package's own chrome — tab strip, nav rails, status bar, focus rings) sees
 * a real value instead of an undefined custom property.
 *
 * Per CSS Custom Properties §3.2, `var(--undefined-thing)` with NO fallback
 * doesn't degrade gracefully — it makes the whole declaration invalid at
 * computed-value time. That is why, without this file, `color:
 * var(--shell-text)` on the package's `.sb-shell.app` was computing to
 * inherited black text on a near-black window, and `outline: 2px solid
 * var(--shell-focus, var(--shell-accent))` was computing to `outline: none`
 * on every focusable shell control.
 *
 * The list below is derived, not guessed: run the package's own
 * `scripts/shell-variables.mjs` (`shellVariableEntries`) against the
 * installed `dist/renderer/styles.css` to regenerate it.
 *
 *   required (no CSS fallback in the package stylesheet — this is the set
 *   that was actually broken):
 *     --shell-accent --shell-accent-muted --shell-active --shell-background
 *     --shell-border --shell-canvas --shell-hover --shell-raised --shell-text
 *     --shell-text-muted --shell-text-subtle
 *
 *   fallback (already resolve safely without this file — defined here anyway
 *   so the app gets a real theme instead of the package's structural
 *   placeholder):
 *     --shell-focus --shell-danger --shell-warning
 *
 *   left alone, deliberately:
 *     --shell-danger-contrast    Package fallback is `var(--shell-text)`,
 *                                which this file defines, so the chain
 *                                already resolves correctly with nothing
 *                                added here.
 *     --shell-status             No surface in `client/src` expresses an
 *                                opinion on this one (a status dot's
 *                                colour). It falls back to
 *                                --shell-text-subtle — neutral and legible —
 *                                rather than guessing a semantic meaning
 *                                (live? idle? something else?) this pass has
 *                                no context to assign correctly.
 *     --shell-border-strong, --shell-space-1..4, --shell-radius,
 *     --shell-radius-small, --shell-control-height, --shell-titlebar-height,
 *     --shell-nav-heading-height, --shell-font, --shell-terminal-background
 *                                All "fallback" kind, and every one of their
 *                                CSS defaults already matches the literal
 *                                pixel/font value every client surface also
 *                                writes as its own fallback (e.g.
 *                                `var(--shell-space-4, 16px)` in
 *                                `dashboard/styles.ts`, `RunCard.tsx`,
 *                                `Workspace.tsx`...). Nothing is invalid
 *                                here; redefining them would just be a
 *                                second place to keep numbers in sync.
 *     --shell-terminal-foreground, --shell-terminal-cursor
 *                                Read only by `readTerminalTheme` in
 *                                JavaScript, only if a consumer mounts
 *                                `TerminalView` — neither Workspace nor
 *                                Dashboard does (`grep -rn "TerminalView"
 *                                src/renderer` is empty). Inventing colours
 *                                for a surface nothing renders yet is a
 *                                guess this pass can't verify against
 *                                anything; add them alongside the terminal
 *                                tab that needs them.
 *
 * Values are derived from what every surface already settled on, not
 * invented fresh: `RunCard.tsx`, `Inspector.tsx`, `Settings.tsx`,
 * `FirstRun.tsx`, `dashboard/styles.ts` and `Workspace.tsx` all fall back to
 * the same hexes for text/border/status colours. Defining them here just
 * means those fallbacks stop being unreachable and start being what actually
 * renders. Where the package needs a token none of those files ever
 * expressed an opinion on (`--shell-canvas`, `--shell-raised`,
 * `--shell-active`, `--shell-accent-muted`), the value chosen is called out
 * below.
 *
 * Contrast ratios (WCAG 2.1 relative luminance) for the pairs that matter —
 * see `task-palette.md` for the full worked set:
 *   --shell-text on --shell-background        16.29:1
 *   --shell-text on --shell-canvas             15.13:1
 *   --shell-text-muted on --shell-background    5.14:1
 *   --shell-text-subtle on --shell-background   3.28:1  (sub-AA; see report)
 *   --shell-accent on --shell-background         5.41:1
 *   --shell-accent on --shell-accent-muted       4.61:1  (nav/icon "selected" text)
 */
const THEME_CSS = `
:root {
  /* Window chrome and side-panel surface. Matches \`createHostWindow\`'s own
     default \`backgroundColor\` (stuffbucket-electron/dist/host/host-window.js)
     so the Electron window paint and this CSS value agree before first
     paint. */
  --shell-background: #16181d;

  /* Main document surface / active tab. One step lighter than
     --shell-background so the canvas reads as its own layer. Every client
     fallback for this token was literally \`transparent\` — "I don't care" —
     so there was no existing opinion to match. */
  --shell-canvas: #1c1f26;

  /* Tooltips and other floating surfaces. Lighter again, for the same
     "no existing opinion" reason as --shell-canvas. */
  --shell-raised: #262a33;

  /* Foreground scale. Exactly what every surface already writes as its own
     var() fallback. */
  --shell-text: #f5f5f5;
  --shell-text-muted: #8a8a8a;
  --shell-text-subtle: #6a6a6a;

  /* Dividers and quiet outlines. Same value as every client fallback. */
  --shell-border: #2a2a2a;

  /* Hover overlay. Client fallbacks split between rgb(255 255 255 / 0.04)
     and 0.06) depending on file; 0.06 sits inside that range.
     --shell-active ("pressed or nested hover" per the package README) is one
     step stronger — no client file picked a value for it, so this is this
     file's own coherent guess. */
  --shell-hover: rgb(255 255 255 / 0.06);
  --shell-active: rgb(255 255 255 / 0.1);

  /* Selection, focus and resize feedback. The teal every focus-ring fallback
     in the codebase already terminates in. */
  --shell-accent: #5198a6;

  /* Selected-control background. A translucent tint of --shell-accent rather
     than a flat colour, so accent-coloured text sitting on top of it (the
     package's \`.nav__item[aria-current='true']\`,
     \`.icon-button[data-active='true']\`) still clears 4.5:1 (4.61:1
     measured) instead of the ~4.2:1 a rounder 0.18 alpha would give. No
     client file picked a value for this token either. */
  --shell-accent-muted: rgb(81 152 166 / 0.12);

  /* Focus indicator. Equal to --shell-accent, matching the
     \`var(--shell-focus, var(--shell-accent, #5198a6))\` chain every surface
     already writes. Defined explicitly so the package's own \`outline: 2px
     solid var(--shell-focus, var(--shell-accent))\` resolves on the first
     name instead of by falling through — the whole point of this file. */
  --shell-focus: var(--shell-accent);

  /* Status colours. Same hexes every surface already uses as its own
     fallback (dashboard/styles.ts, RunCard.tsx, Settings.tsx). Not part of
     the package's own required contract, but centralized here so those three
     files stop each hardcoding the same fallback independently. */
  --shell-danger: #ef4444;
  --shell-warning: #eab308;
  --shell-success: #22c55e;
}
`

const THEME_STYLE_ID = 'maximal-theme'

if (typeof document !== 'undefined' && !document.getElementById(THEME_STYLE_ID)) {
  const style = document.createElement('style')
  style.id = THEME_STYLE_ID
  style.textContent = THEME_CSS
  document.head.appendChild(style)
}
