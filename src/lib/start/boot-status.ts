/**
 * Structured boot-phase line the Tauri shell relays to its splash window as
 * live status (so a slow or failed start isn't a blank "Starting…" or a
 * silently-cleared splash). No-op for plain CLI users — gated on the
 * parent-pid env the shell sets when it spawns the sidecar — so their
 * terminal never sees the marker. MUST stay in sync with the marker
 * `BOOT_STATUS_MARKER` constant in shell/src-tauri/src/lib.rs.
 */

export const BOOT_STATUS_MARKER = "@@MAXIMAL_STATUS@@"

export function emitBootStatus(message: string): void {
  if (!process.env.MAXIMAL_SIDECAR_PARENT_PID) return
  process.stdout.write(`${BOOT_STATUS_MARKER} ${message}\n`)
}
