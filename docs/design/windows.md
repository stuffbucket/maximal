# Window family: Settings + Dashboard + Sessions

Settings (`shell/ui/settings/index.html` + `shell/src/`) is the outer shell for
three peer surfaces. Dashboard and Sessions share one persistent observability
iframe (`shell/ui/dashboard/` + `shell/src/dashboard/`) so their live state and
polling survive surface switches.

## What's shared

- Follow the OS appearance (`prefers-color-scheme`), dark when it gives
  no preference; `data-theme` on `<html>` pins one. Same generated theme
  blocks in both bundles.
- Same crimson `--brand` for identity. Same teal `--accent` for
  interactive surfaces.
- Same Commissioner body face. Fraunces is rationed to the brand mark
  and **one** display heading per window; Dashboard and Sessions have no display
  moment, so the observability bundle doesn't load Fraunces.
- Same token vocabulary and values, generated from
  `shell/src/ui/styles/theme.ts` (see [`tokens.md`](tokens.md)). Same
  spacing scale, three surface levels, three elevation levels.
- Both bundles are built by Bun (`scripts/build-ui.ts`) and served by the proxy
  under `/ui/settings/` and `/ui/dashboard/`; `/ui/sessions/` redirects to the
  observability bundle's Sessions surface.

## Where they diverge

| Concern | Dashboard | Sessions | Settings |
|---|---|---|---|
| Topbar center | Period segmented control (`1d / 7d / 30d`) + range label | Empty | 5 consolidated tabs (`Account`, `Integrations`, `Models`, `Appearance`, `System`) |
| Content | Quotas, token totals and live-flow graph | Live and recent session table | Configuration sections and app integrations |
| Layout | Wide single column in the observability bundle | Wide single column in the same persistent bundle | Single centered column (`--content-max` sections) below `.topbar` |
| Build | Hand-authored observability HTML + bundled `main.ts` | Same Dashboard artifact and controllers | Bun bundles `index.html` and its React + vanilla islands |
| Tokens live in | Generated region of `shell/ui/dashboard/style.css` | Same observability token set | `shell/src/ui/styles/tokens.css`, imported by `styles.css` |

The desktop app has one single-instance window and one top bar (`.topbar` with
`data-tauri-drag-region`, styled with `--surface-card` and
`TitleBarStyle::Overlay` on macOS). Its far-right three-way surface switcher
opens Settings, Dashboard or Sessions; the language control follows it. The
observability iframe stays mounted while its internal Dashboard/Sessions view
changes, so graph selection, the session table and the single sessions polling
loop persist. The window remembers the last surface (`maximal.lastTab`) and the
last Settings tab (`maximal.lastSettingsTab`), and overrides to **Settings →
Account** on first run or whenever an account error or upstream rejection is
active.

The native window uses `1100×720` only as its first-launch fallback. Tauri's
official window-state plugin persists the unified window label's size, position,
and maximized state across process launches. It does not persist visibility
(close still hides to the tray), decorations, or fullscreen. The window is
created hidden and shown after restoration, so returning users do not see it
paint at the fallback size first. Switching among the three surfaces only changes
content and title; it does not change native window geometry.
