# Keyboard

CLI users and power users reach for keys before mouse. These bindings
are honored across every window unless a window-specific section
overrides; bindings that conflict with OS conventions lose to the OS.

| Binding | Action | Scope | Status | Notes |
|---|---|---|---|---|
| `Cmd-,` | Open Settings | Tray menu | **shipped** | macOS convention. Opens or focuses Settings. |
| `Cmd-D` | Open Dashboard | Tray menu | **shipped** | Opens or focuses the Dashboard. |
| `Cmd-Q` | Quit Maximal | Tray menu | **shipped** | Confirms in a native dialog, then stops the sidecar (SIGTERM, SIGKILL after a grace period). |
| `Cmd-W` | Close current window | Per window | **planned** | Hides; doesn't quit (same as the window's close button). |
| `Esc` | Close current window | Per window | **planned** | Same as Cmd-W; natural for modal-feel windows. |
| `Cmd-R` | Refresh current window | Dashboard, Settings | **planned** | Re-fetches the window's data. |
| `Cmd-Shift-,` | Reveal config in editor | Settings | **planned** | Power-user escape hatch. |
| `Cmd-K` | Command palette | Global | **reserved** | Not bound in v1. The keybind is reserved so users who try it don't accidentally hit a different action. **Don't repurpose.** |

> **Status definitions.** *Shipped* = implemented. *Planned* = on the
> roadmap; no app code binds it. *Reserved* = explicitly not bound; do
> not bind to anything else. Confirm against the codebase before adding
> new listeners — see [`failure-modes.md`](failure-modes.md).

## Implementation

- **Tray-menu bindings** (`Cmd-,`, `Cmd-D`, `Cmd-Q`): accelerators on
  the tray `MenuItem`s in `build_menu` (`shell/src-tauri/src/lib.rs`),
  written as `CmdOrCtrl+…`. There is no global-shortcut plugin; these
  aren't system-wide hotkeys.
- **In-window bindings**: per-window `keydown` listeners in the window's
  frontend code (`shell/src/` for Settings, `shell/src/dashboard/` for
  the Dashboard). None of the window-level bindings above exist yet;
  the only `keydown` / `Escape` handlers today are component-local
  (dismissing a tooltip or an inline editor, arrow keys in the
  Dashboard's period selector).
- **Cross-platform**: listeners check `event.metaKey` (macOS) and
  `event.ctrlKey` (Windows / Linux) so the same bindings work
  everywhere.

## Affordance

Tooltips on the corresponding visible affordances include the
keybind in parens: `Settings (⌘,)`. **Quietly** — the binding doesn't
need to be screamed; it's a power move.
