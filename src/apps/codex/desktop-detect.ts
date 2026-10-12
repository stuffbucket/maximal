import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { AppInstall } from "~/lib/config/settings-types"

/** Both macOS app names ship the Codex app server. Requiring that executable
 * avoids treating an older, chat-only ChatGPT install as a Codex client. */
export function detectCodexDesktop(
  options: {
    platform?: NodeJS.Platform
    applicationDirs?: Array<string>
  } = {},
): Promise<Array<AppInstall>> {
  if ((options.platform ?? process.platform) !== "darwin")
    return Promise.resolve([])
  const directories = options.applicationDirs ?? [
    "/Applications",
    path.join(os.homedir(), "Applications"),
  ]
  const installs: Array<AppInstall> = []
  for (const directory of directories) {
    for (const name of ["Codex.app", "ChatGPT.app"]) {
      const appPath = path.join(directory, name)
      const executable = path.join(appPath, "Contents", "Resources", "codex")
      try {
        fs.accessSync(executable, fs.constants.X_OK)
        if (!fs.statSync(executable).isFile()) continue
        installs.push({ path: appPath, version: null, source: "unknown" })
      } catch {
        // Missing or incomplete installs don't enable the switch.
      }
    }
  }
  return Promise.resolve(installs)
}
