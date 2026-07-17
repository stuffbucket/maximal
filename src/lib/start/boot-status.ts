/**
 * Structured stdout markers the Tauri shell reads from the sidecar it spawns.
 *
 * `BOOT_STATUS_MARKER` — boot-phase lines relayed to the splash as live status
 * (so a slow/failed start isn't a blank "Starting…"). `QUIT_REQUEST_MARKER` — the
 * browser-tab UI's way to quit the whole app: a tab has no Tauri host to `invoke`
 * a quit, so it POSTs the sidecar, which signals the shell over this same channel.
 *
 * Both are no-ops for plain CLI users — gated on the parent-pid env the shell sets
 * when it spawns the sidecar — so their terminal never sees a marker. MUST stay in
 * sync with the `BOOT_STATUS_MARKER` / `QUIT_REQUEST_MARKER` constants in
 * shell/src-tauri/src/lib.rs.
 */

export const BOOT_STATUS_MARKER = "@@MAXIMAL_STATUS@@"

export function emitBootStatus(message: string): void {
  if (!process.env.MAXIMAL_SIDECAR_PARENT_PID) return
  process.stdout.write(`${BOOT_STATUS_MARKER} ${message}\n`)
}

export const QUIT_REQUEST_MARKER = "@@MAXIMAL_QUIT@@"

/**
 * Ask the supervising Tauri shell to quit the whole app (shell + sidecar). Returns
 * whether a shell is present to receive the request (false on a plain-CLI run,
 * where there is nothing to quit and the caller should say so).
 */
export function emitQuitRequest(): boolean {
  if (!process.env.MAXIMAL_SIDECAR_PARENT_PID) return false
  process.stdout.write(`${QUIT_REQUEST_MARKER}\n`)
  return true
}
