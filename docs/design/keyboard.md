# Keyboard

CLI users and power users reach for keys before mouse. These bindings
are honored across every window unless a window-specific section
overrides; bindings that conflict with OS conventions lose to the OS.

| Binding | Action | Scope | Status | Notes |
|---|---|---|---|---|
| `Cmd-,` | Open Settings | Global (tray-active) | **shipped** | macOS convention. Opens or focuses Settings. |
| `Cmd-Q` | Quit Maximal | Global (tray-active) | **shipped** | SIGTERMs the sidecar via the existing kill path. |
| `Cmd-W` | Close current window | Per window | **shipped** | Hides; doesn't quit. |
| `Esc` | Close current window | Per window | **shipped** | Same as Cmd-W; natural for modal-feel windows. |
| `Cmd-R` | Refresh current window | Dashboard | **shipped** | Re-fetches `/setup-status`, `/usage`, `/activity`. Settings: re-fetches `/config`. Setup: no-op. |
| `Cmd-Shift-,` | Reveal config in editor | Settings → Advanced | **planned** | Power-user escape hatch. |
| `Cmd-K` | Command palette | Global | **reserved** | Not bound in v1. The keybind is reserved so users who try it don't accidentally hit a different action. **Don't repurpose.** |

> **Status definitions.** *Shipped* = implemented and tested.
> *Planned* = on the roadmap; not implemented. *Reserved* = explicitly
> not bound; do not bind to anything else. Confirm against the
> codebase before adding new listeners — see
> [`failure-modes.md`](failure-modes.md).

## Implementation

- **Tray-active globals** (`Cmd-,`, `Cmd-Q`): Tauri's
  `tauri-plugin-global-shortcut`.
- **In-window bindings**: per-window `keydown` listeners in the Vite
  frontend.
- **Cross-platform**: listeners check `event.metaKey` (macOS) and
  `event.ctrlKey` (Windows / Linux) so the same bindings work
  everywhere.

## Affordance

Tooltips on the corresponding visible affordances include the
keybind in parens: `Settings (⌘,)`. **Quietly** — the binding doesn't
need to be screamed; it's a power move.
