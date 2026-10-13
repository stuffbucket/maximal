import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  applyCodexProvider,
  getCodexConfigPath,
  isCodexProviderConfigured,
  revertCodexProvider,
} from "~/apps/codex/provider"

const originalCodexHome = process.env.CODEX_HOME

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
})

describe("Codex provider boundary", () => {
  test("resolves CODEX_HOME at call time and treats an empty value as unset", () => {
    process.env.CODEX_HOME = "/tmp/first-codex-home"
    expect(getCodexConfigPath({ homeDir: "/tmp/home" })).toBe(
      "/tmp/first-codex-home/config.toml",
    )

    process.env.CODEX_HOME = "/tmp/second-codex-home"
    expect(getCodexConfigPath({ homeDir: "/tmp/home" })).toBe(
      "/tmp/second-codex-home/config.toml",
    )

    process.env.CODEX_HOME = ""
    expect(getCodexConfigPath({ homeDir: "/tmp/home" })).toBe(
      "/tmp/home/.codex/config.toml",
    )
  })

  test("inspects valid owned routing without mutating the config", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-codex-"))
    const filePath = path.join(directory, "config.toml")
    try {
      expect(isCodexProviderConfigured({ filePath })).toBe(false)
      applyCodexProvider({ filePath, execPath: "/opt/maximal/bin/maximal" })
      const applied = fs.readFileSync(filePath, "utf8")

      expect(isCodexProviderConfigured({ filePath })).toBe(true)
      expect(fs.readFileSync(filePath, "utf8")).toBe(applied)

      fs.writeFileSync(
        filePath,
        applied.replace('name = "Maximal"', 'name = "Customized"'),
      )
      expect(isCodexProviderConfigured({ filePath })).toBe(false)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("writes a structured Maximal auth invocation and reverts exactly", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-codex-"))
    const filePath = path.join(directory, "config.toml")
    const original = 'model_provider = "openai"\n'
    try {
      fs.writeFileSync(filePath, original)
      const applied = applyCodexProvider({
        filePath,
        execPath: "/Applications/Maximal.app/Contents/MacOS/maximal",
      })

      expect(applied.wrote).toBe(true)
      expect(applied.content).toContain(
        'command = "/Applications/Maximal.app/Contents/MacOS/maximal"',
      )
      expect(applied.content).toContain('args = ["api","codex"]')
      expect(revertCodexProvider({ filePath })).toMatchObject({
        status: "changed",
        wrote: true,
      })
      expect(fs.readFileSync(filePath, "utf8")).toBe(original)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
