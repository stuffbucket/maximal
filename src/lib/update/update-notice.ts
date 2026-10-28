/**
 * The update line `maximal start` logs, for people who run the proxy without
 * the desktop app (a headless Linux service, a terminal). At startup and then
 * every few hours it runs the same check Settings uses, and when a newer
 * version is out it logs one line saying how to get it: the apt command for an
 * apt install, the download page otherwise. Best-effort, like the check.
 */

import consola from "consola"

import { updateAvailableMessage } from "~/lib/update/install-source"
import { DOWNLOAD_URL, getUpdateStatus } from "~/lib/update/update-check"

/** Matches the check's cache lifetime: a release is rare. */
const NOTICE_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Check once and log the line if a newer version is available. Returns the
 *  line it logged, or null. */
export async function checkAndLogUpdate(
  log: (line: string) => void = (line) => consola.info(line),
): Promise<string | null> {
  const status = await getUpdateStatus(true)
  if (!status.update_available || !status.latest) return null
  const line = updateAvailableMessage(
    status.latest,
    status.update_command,
    DOWNLOAD_URL,
  )
  log(line)
  return line
}

function runCheck(): void {
  void checkAndLogUpdate().catch(() => {
    // getUpdateStatus never throws; nothing to report.
  })
}

/** Start the startup + periodic check. The timer never keeps the process
 *  alive on its own. */
export function startUpdateNotice(): void {
  runCheck()
  setInterval(runCheck, NOTICE_INTERVAL_MS).unref()
}
