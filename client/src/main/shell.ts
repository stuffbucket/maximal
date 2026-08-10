// The shell seam — now backed by the `stuffbucket/electron` shell DEPENDENCY.
//
// The client's window is created by the shell's `createHostWindow(options)`
// (imported from the `stuffbucket-electron` package); the client injects its own
// preload + renderer + core origin, so the shell stays maximal-agnostic. When
// the shell grows a fuller `runMain(runtime, options)`, this swaps to it with a
// localized change (maximal-electron#22).
import { createHostWindow, type HostWindowOptions } from 'stuffbucket-electron/host'

export type ShellOptions = HostWindowOptions

/**
 * Defaults `titleBarStyle` to `'hiddenInset'`.
 *
 * The package's own `TitleBar` (`stuffbucket-electron/renderer`) draws a
 * custom in-page title bar and, on macOS, unconditionally reserves 68px
 * (`.titlebar__spacer-mac`) for native traffic lights — it assumes the
 * window it's rendered into has no native title bar of its own.
 * `createWindow()` (`main/index.ts`) passed no `titleBarStyle`, so Electron
 * gave the window a native one: a native "Maximal" title bar, a second
 * in-page title bar below it, and 68px of dead space to the left of the tab
 * strip where traffic lights that live in the native bar were expected to
 * be.
 *
 * `HostWindowOptions.titleBarStyle` plumbs straight through to
 * `BrowserWindow`, so the fix belongs here — one default matching what the
 * shell package's own chrome expects — rather than in `main/index.ts`,
 * which would need the same value repeated at every `runShell()` call site.
 * A caller that ever needs different chrome still can: an explicit
 * `titleBarStyle` in `options` wins, since it's spread after the default.
 */
export function runShell(options: HostWindowOptions): ReturnType<typeof createHostWindow> {
  return createHostWindow({ titleBarStyle: 'hiddenInset', ...options })
}
