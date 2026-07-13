import type { ArgsDef } from "citty"

import type { AppEntry } from "~/lib/config/settings-types"

/** The mutation a `maximal app <client>` invocation asks for. `status` is the
 *  default (no flag) — show the client's detect/enabled state without changing
 *  anything; `enable`/`disable` map to the `--enable` / `--disable` flags. */
export type AppCliOp = "status" | "enable" | "disable"

/** Optional per-app hook into the generic `maximal app <client>` command.
 *  The framework already offers status/enable/disable for every app via the
 *  `ClientApp` contract; this only exists for apps that need EXTRA flags or
 *  bespoke handling (e.g. Claude Desktop's `--force` / `--managed`). */
export interface AppCli {
  /** Extra citty args merged into this app's command beyond the shared
   *  `--enable` / `--disable`. */
  extraArgs?: ArgsDef
  /** First crack at an operation. Return `true` when it fully handled things
   *  (the generic enable/disable/status is then skipped); return `false` to
   *  fall through to the `ClientApp` contract. */
  handle?(
    op: AppCliOp,
    args: Record<string, unknown>,
  ): boolean | Promise<boolean>
}

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

  /** The label used BOTH to resolve this client's key via `maximal api <client>`
   *  AND (for apps that write one) as the `api <client>` token in the client's
   *  on-disk config — one field because they must resolve the same key.
   *  Absent (undefined) means the app exposes no key surface (e.g. coming-soon):
   *  `maximal api <client>` then reports "no key" instead of minting the
   *  default endpoint key. */
  readonly apiKeyLabel?: string

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

  /** Optional hook into the generic `maximal app <client>` command for apps
   *  that need extra flags or bespoke handling beyond the shared
   *  status/enable/disable (see `AppCli`). Absent for apps that only need the
   *  generic behaviour. */
  cli?: AppCli
}
