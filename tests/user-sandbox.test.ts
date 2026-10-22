import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"

import { getTestUserSandbox, sandboxEnv } from "./helpers/user-sandbox"

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
}

describe("test user sandbox", () => {
  it("contains home and platform data directories", () => {
    const { root, env } = getTestUserSandbox()
    expect(isWithin(root, os.homedir())).toBe(true)
    for (const [name, directory] of Object.entries(env)) {
      if (name === "HOMEDRIVE" || name === "HOMEPATH") continue
      expect(isWithin(root, directory)).toBe(true)
    }
    const windowsHome = path.resolve(`${env.HOMEDRIVE}${env.HOMEPATH}`)
    expect(isWithin(root, windowsHome)).toBe(true)
  })

  it("propagates the sandbox to child processes", () => {
    const { root } = getTestUserSandbox()
    const script = [
      'const os = require("node:os")',
      "const names = [",
      '  "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME",',
      '  "XDG_CACHE_HOME", "XDG_STATE_HOME", "APPDATA", "LOCALAPPDATA",',
      '  "COPILOT_API_HOME", "CLAUDE_CONFIG_DIR", "MISE_CONFIG_DIR",',
      '  "MISE_DATA_DIR", "MISE_CACHE_DIR", "MISE_STATE_DIR",',
      '  "TMPDIR", "TMP", "TEMP",',
      "]",
      "console.log(JSON.stringify({",
      "  home: os.homedir(),",
      "  windowsHome: `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`,",
      "  directories: names.map((name) => process.env[name]),",
      "}))",
    ].join("\n")
    const result = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: sandboxEnv(),
    })
    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout.trim()) as {
      home: string
      windowsHome: string
      directories: Array<string>
    }
    expect(isWithin(root, output.home)).toBe(true)
    expect(isWithin(root, path.resolve(output.windowsHome))).toBe(true)
    for (const directory of output.directories) {
      expect(isWithin(root, directory)).toBe(true)
    }
  })
})
