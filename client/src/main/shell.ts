// The shell seam — now backed by the `stuffbucket/electron` shell DEPENDENCY.
//
// The client's window is created by the shell's `createHostWindow(options)`
// (imported from the `stuffbucket-electron` package); the client injects its own
// preload + renderer + core origin, so the shell stays maximal-agnostic. When
// the shell grows a fuller `runMain(runtime, options)`, this swaps to it with a
// localized change (maximal-electron#22).
import { createHostWindow, type HostWindowOptions } from 'stuffbucket-electron/host'

export type ShellOptions = HostWindowOptions
export const runShell = createHostWindow
