import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { AppInstall } from "~/lib/config/settings-types"

export async function detectCodex(): Promise<Array<AppInstall>> {
  const home = os.homedir()
  const directories = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, "npm")] : []),
  ].filter(Boolean)
  const names =
    process.platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"]
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.resolve(directory, name)
      try {
        fs.accessSync(
          candidate,
          process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK,
        )
        if (!fs.statSync(candidate).isFile()) continue
      } catch {
        continue
      }
      const version = await new Promise<string | null>((resolve) => {
        execFile(
          candidate,
          ["--version"],
          { timeout: 3000, maxBuffer: 4096, windowsHide: true },
          (error, stdout) => {
            resolve(
              error ? null : (
                (/codex-cli\s+(\d+\.\d+\.\d+)/u.exec(stdout)?.[1] ?? null)
              ),
            )
          },
        )
      })
      return [{ path: candidate, version, source: "path" }]
    }
  }
  return []
}
