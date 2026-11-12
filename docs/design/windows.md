# Window family: Settings + Dashboard + Sessions + Rules

Settings (`shell/ui/settings/index.html` + `shell/src/`) is the outer shell for
four peer surfaces. Dashboard and Sessions share one persistent observability
iframe (`shell/ui/dashboard/` + `shell/src/dashboard/`) so their live state and
polling survive surface switches. Rules (called Budget before; the code keeps
that name) is a React section of the Settings
bundle (`shell/src/ui/features/budget/`, mounted by
`shell/src/ui/islands/budget-island.tsx`) that main.ts shows and hides like any
other section; it keeps its own live state (the `budget.changed` event stream)
while mounted.

## What's shared

- Follow the OS appearance (`prefers-color-scheme`), dark when it gives
  no preference; `data-theme` on `<html>` pins one. Same generated theme
  blocks in both bundles.
- Same crimson `--brand` for identity. Same teal `--accent` for
  interactive surfaces.
- Same Commissioner body face. Fraunces is rationed to the brand mark
  and **one** display heading per window; Dashboard and Sessions have no display
  moment, so the observability bundle doesn't load Fraunces. Rules' one display
  heading is its first section's (Rules), never the window name.
- Same token vocabulary and values, generated from
  `shell/src/ui/styles/theme.ts` (see [`tokens.md`](tokens.md)). Same
  spacing scale, three surface levels, three elevation levels.
- Both bundles are built by Bun (`scripts/build-ui.ts`) and served by the proxy
  under `/ui/settings/` and `/ui/dashboard/`; `/ui/sessions/` redirects to the
  observability bundle's Sessions surface, and `/ui/rules/` (and the old
  `/ui/budget/`) to the Rules section (`/ui/settings/#rules`).

## Where they diverge

| Concern        | Dashboard                                                | Sessions                                         | Rules                                                                   | Settings                                                                          |
| -------------- | -------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Topbar center  | Period segmented control (`1d / 7d / 30d`) + range label | Empty                                            | Empty                                                                   | 5 consolidated tabs (`Account`, `Integrations`, `Models`, `Appearance`, `System`) |
| Content        | Quotas, token totals and live-flow graph                 | Compact live and recent session list             | Rules, Activity, Settings (enforcement, display unit, provider allowances) | Configuration sections and app integrations                                       |
| Layout         | Wide single column in the observability bundle           | Wide single column in the same persistent bundle | Single centered column (`--content-max` sections) below `.topbar`      | Single centered column (`--content-max` sections) below `.topbar`                 |
| Build          | Hand-authored observability HTML + bundled `main.ts`     | Same Dashboard artifact and controllers          | React island in the Settings bundle                                     | Bun bundles `index.html` and its React + vanilla islands                          |
| Tokens live in | Generated region of `shell/ui/dashboard/style.css`       | Same observability token set                     | `shell/src/ui/styles/tokens.css`, imported by `styles.css`              | `shell/src/ui/styles/tokens.css`, imported by `styles.css`                        |

The desktop app has one single-instance window and one top bar (`.topbar` with
`data-tauri-drag-region`, styled with `--surface-card` and
`TitleBarStyle::Overlay` on macOS). Its far-right four-way surface switcher
opens Settings, Dashboard, Sessions or Rules; the language control follows it. The
observability iframe stays mounted while its internal Dashboard/Sessions view
changes, so graph selection, the session list and the single sessions polling
loop persist. The window remembers the last surface (`maximal.lastTab`) and the
last Settings tab (`maximal.lastSettingsTab`), and overrides to **Settings →
Account** on first run or whenever an account error or upstream rejection is
active.

The native window uses `1100×720` only as its first-launch fallback. Tauri's
official window-state plugin persists the unified window label's size, position,
and maximized state across process launches. It does not persist visibility,
decorations, or fullscreen. Closing is platform-native: macOS/Linux hide the window back to the menu
bar/tray, while Windows X asks for confirmation before gracefully stopping the
sidecar and quitting Maximal. On Windows the restored unified window is shown
minimized without activation after startup, which gives the default always-on
taskbar presence without flashing or stealing focus. Explicit actions and
first-run account setup restore and focus that same window. The window is
created hidden and shown after restoration, so returning users do not see it
paint at the fallback size first. The plugin's automatic initial restore is
skipped so the shell can run a controlled restore after the plugin's window-ready
hook, then repair geometry before showing: physical inner size is checked against
the current monitor's physical work area, native frame extent is reserved
separately, and outer position is brought back on-screen. The restore runs off the
main event loop because Tauri's synchronous geometry getters dispatch through that
loop. Maximized state is restored without mutating constraints while the window is
maximized.

Constraints follow the active surface rather than one global rectangle. Settings
has a minimum logical width that keeps all five tabs separated from the pinned
utilities (the four-button surface switcher counts toward it), a maximum width
matching its bounded readable layout, and no maximum height. Dashboard, Sessions
and Rules use the smaller shared minimum (they show no tabs) and clear both
maxima: the Dashboard and Sessions tables and graphs benefit from wider and
taller windows, and Rules keeps its `--content-max` column centered in whatever
room there is. The frontend
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
The Dock/taskbar persistence control is hidden on Windows, where the unified
window starts minimized in the taskbar and closing it asks before exiting.
