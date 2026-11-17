/**
 * How an in-place update attempt ended (`install_update` in the shell). Kept
 * apart from the IPC wrapper so DOM-free code (the update flow and its tests)
 * can name it without loading the Tauri bridge.
 */
export type InstallUpdateOutcome =
  | "unavailable"
  | "busy"
  | "cancelled"
  | "failed";

export const INSTALL_UPDATE_OUTCOMES: ReadonlyArray<InstallUpdateOutcome> = [
  "unavailable",
  "busy",
  "cancelled",
  "failed",
];
