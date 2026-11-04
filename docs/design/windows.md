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

| Concern        | Dashboard                                                | Sessions                                         | Settings                                                                          |
| -------------- | -------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| Topbar center  | Period segmented control (`1d / 7d / 30d`) + range label | Empty                                            | 5 consolidated tabs (`Account`, `Integrations`, `Models`, `Appearance`, `System`) |
| Content        | Quotas, token totals and live-flow graph                 | Compact live and recent session list             | Configuration sections and app integrations                                       |
| Layout         | Wide single column in the observability bundle           | Wide single column in the same persistent bundle | Single centered column (`--content-max` sections) below `.topbar`                 |
| Build          | Hand-authored observability HTML + bundled `main.ts`     | Same Dashboard artifact and controllers          | Bun bundles `index.html` and its React + vanilla islands                          |
| Tokens live in | Generated region of `shell/ui/dashboard/style.css`       | Same observability token set                     | `shell/src/ui/styles/tokens.css`, imported by `styles.css`                        |

The desktop app has one single-instance window and one top bar (`.topbar` with
`data-tauri-drag-region`, styled with `--surface-card` and
`TitleBarStyle::Overlay` on macOS). Its far-right three-way surface switcher
opens Settings, Dashboard or Sessions; the language control follows it. The
observability iframe stays mounted while its internal Dashboard/Sessions view
changes, so graph selection, the session list and the single sessions polling
loop persist. The window remembers the last surface (`maximal.lastTab`) and the
last Settings tab (`maximal.lastSettingsTab`), and overrides to **Settings →
Account** on first run or whenever an account error or upstream rejection is
active.

The native window uses `1100×720` only as its first-launch fallback. Tauri's
official window-state plugin persists the unified window label's size, position,
and maximized state across process launches. It does not persist visibility,
decorations, or fullscreen. Closing is platform-native: macOS/Linux hide the
window back to the menu bar/tray, while Windows X gracefully stops the sidecar
and quits Maximal. The window is created hidden and shown after restoration, so
returning users do not see it paint at the fallback size first. The plugin's automatic initial restore is
skipped so the shell can run a controlled restore after the plugin's window-ready
hook, then repair geometry before showing: physical inner size is checked against
the current monitor's physical work area, native frame extent is reserved
separately, and outer position is brought back on-screen. The restore runs off the
main event loop because Tauri's synchronous geometry getters dispatch through that
loop. Maximized state is restored without mutating constraints while the window is
maximized.

Constraints follow the active surface rather than one global rectangle. Settings
has a minimum logical width that keeps all five tabs separated from the pinned
utilities, a maximum width matching its bounded readable layout, and no maximum
height. Dashboard and Sessions use the smaller shared minimum and clear both maxima
because their tables and graphs benefit from wider and taller windows. The frontend
remains responsive inside those native ranges: Settings sections are centered and
fluid up to `--content-max`, Dashboard's wide container is centered and fluid, and
Sessions keeps its narrow-row reflow. The native-overlay top bar remains one row;
its Settings tabs can scroll for longer localized labels rather than increasing the
title-bar height, the active tab is kept in view, and the scrollport reserves a
fixed gap before the pinned surface and language controls. Switching to Settings
may clamp an
observability window that is wider than Settings' range; switching back removes
that cap without forcing a resize.

Native status affordances follow each platform rather than sharing one rendering
policy. macOS menu-bar artwork is a black-and-alpha AppKit template image; AppKit
supplies the light, dark, and selected-state color. Windows notification-area
artwork remains full color and keeps a high-contrast silhouette on both light and
dark taskbars. Right-clicking a running Windows taskbar button shows a static
Jump List of durable quick actions that launch back through the single-instance
shell. Dynamic status rows, pending requests, Retry, and Quit remain in the
notification-area menu because Jump List tasks persist when the app is stopped.
The Dock/taskbar persistence control is hidden on Windows, where closing the
window now exits instead of leaving a closed window represented in the taskbar.
