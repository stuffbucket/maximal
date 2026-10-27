# Window family: Settings + Dashboard

The Settings window (`shell/ui/settings/index.html` + `shell/src/`) and
the Dashboard window (`shell/ui/dashboard/` + `shell/src/dashboard/`)
share one design language. This doc codifies what's shared and where
they diverge.

## What's shared

- Follow the OS appearance (`prefers-color-scheme`), dark when it gives
  no preference; `data-theme` on `<html>` pins one. Same generated theme
  blocks in both windows.
- Same crimson `--brand` for identity. Same teal `--accent` for
  interactive surfaces.
- Same Commissioner body face. Fraunces is rationed to the brand mark
  and **one** display heading per window; the Dashboard has no display
  moment, so it doesn't load Fraunces.
- Same token vocabulary and values, generated from
  `shell/src/ui/styles/theme.ts` (see [`tokens.md`](tokens.md)). Same
  spacing scale, three surface levels, three elevation levels.
- Both are built by Bun (`scripts/build-ui.ts`) and served by the proxy
  under `/ui/settings/` and `/ui/dashboard/`.

## Where they diverge

| Concern | Dashboard | Settings |
|---|---|---|
| Topbar center | Period segmented control (`1d / 7d / 30d`) + range label | 5 consolidated tabs (`Account`, `Integrations`, `Models & keys`, `Appearance`, `System`) |
| Layout | Single column in a Tailwind `max-w-7xl` container (embedded inside `.pane--dashboard` or standalone) | Single centered column (`--content-max` sections) below `.topbar` |
| Build | Hand-authored HTML + `style.css` copied verbatim; only `shell/src/dashboard/main.ts` is bundled. Tailwind and Lucide load as vendored classic `<script>`s | Bun bundles `index.html` and its imports (React + vanilla islands) |
| Tokens live in | Generated region of `shell/ui/dashboard/style.css` (a subset — see [`failure-modes.md`](failure-modes.md) → *Known active drift*) | `shell/src/ui/styles/tokens.css`, imported by `styles.css` |

In the desktop app, Settings and Dashboard share a **single unified window** with a single top bar (`.topbar` with `data-tauri-drag-region`, styled with `--surface-card` and `TitleBarStyle::Overlay` on macOS). The far-right utility cluster holds the language globe icon button and a mode-toggle icon button (`[data-surface-mode-btn]`) that flips between a Dashboard chart icon (while in Settings) and a Settings gear icon (while in Dashboard). The window remembers the last selected tab (`maximal.lastTab` / `maximal.lastSettingsTab`) and overrides to **Settings → Account** on first run (unauthenticated) or whenever an account error or upstream rejection is active.
