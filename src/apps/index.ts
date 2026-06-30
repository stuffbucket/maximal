import type { CommandDef } from "citty"

import type { AppEntry } from "~/lib/settings-types"

/** Result of reverting an app's integration during `maximal uninstall`. */
export interface AppUninstallResult {
  /** Human-readable lines describing what was reverted, in display order.
   *  Empty when the app had nothing wired (no-op), so the uninstaller can
   *  report uniformly without knowing each app's specifics. */
  reverted: Array<string>
}

export interface ClientApp {
  readonly id: AppEntry["id"]
  readonly name: string
  readonly kind: AppEntry["kind"]

  /** Is the application installed on the user's computer? */
  detect(): Promise<boolean>

  /** Build the complete metadata payload returned to the Settings UI */
  getDetails(conflict?: AppEntry["conflict"]): Promise<AppEntry>

  /** Enable the proxy routing for this app (e.g. write settings / profile) */
  enable(): Promise<{ success: boolean; conflict?: AppEntry["conflict"] }>

  /** Disable/revert the proxy routing for this app */
  disable(): Promise<{ success: boolean }>

  /** Is proxy routing currently active for this app? */
  isEnabled(): boolean

  /** Revert everything this app integration wrote to the user's machine
   *  (config files, profiles). Ownership-guarded and marker-scoped like
   *  enable/disable: removes only what maximal added, no-op when absent. Drives
   *  `maximal uninstall`, so the uninstaller never hard-codes per-app paths. */
  uninstall(): Promise<AppUninstallResult>

  /** Optional hook called when the proxy starts up */
  onBoot?(): Promise<void>

  /** Optional hook called when the proxy shuts down (for crash cleanup) */
  onShutdown?(): Promise<void>

  /** Optional CLI command config for citty (e.g. configure-claude-code).
   *  `CommandDef<any>` mirrors citty's own `SubCommandsDef`: each app's command
   *  declares its own arg shape, which isn't assignable to the default
   *  `CommandDef<ArgsDef>` (citty's known generic invariance). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches citty's SubCommandsDef = Record<string, Resolvable<CommandDef<any>>>
  cliCommand?: CommandDef<any>
}
