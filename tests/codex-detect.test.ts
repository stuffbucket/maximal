import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { detectCodexInstallations } from "~/apps/codex/detect"

describe("Codex filesystem detection", () => {
  test("finds a POSIX CLI through a symlink and reports the resolved path", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-codex-"))
    try {
      const bin = path.join(directory, "bin")
      const links = path.join(directory, "links")
      fs.mkdirSync(bin)
      fs.mkdirSync(links)
      const executable = path.join(bin, "codex")
      fs.writeFileSync(executable, "not executed", { mode: 0o755 })
      fs.symlinkSync(executable, path.join(links, "codex"))

      expect(
        detectCodexInstallations({
          platform: "darwin",
          pathEnv: links,
          homeDir: path.join(directory, "empty-home"),
          applicationDirs: [],
        }),
      ).toEqual([
        { kind: "cli", path: fs.realpathSync(executable), version: null },
      ])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("rejects non-executable POSIX CLI artifacts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-codex-"))
    try {
      const bin = path.join(directory, "bin")
      fs.mkdirSync(bin)
      fs.writeFileSync(path.join(bin, "codex"), "not executed", { mode: 0o644 })

      expect(
        detectCodexInstallations({
          platform: "linux",
          pathEnv: bin,
          homeDir: directory,
        }),
      ).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("rejects an executable directory named codex", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-codex-"))
    try {
      const bin = path.join(directory, "bin")
      fs.mkdirSync(path.join(bin, "codex"), { recursive: true })

      expect(
        detectCodexInstallations({
          platform: "linux",
          pathEnv: bin,
          homeDir: directory,
          applicationDirs: [],
        }),
      ).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("splits POSIX PATH entries with a colon", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-codex-"))
    try {
      const first = path.join(directory, "first")
      const second = path.join(directory, "second")
      fs.mkdirSync(first)
      fs.mkdirSync(second)
      const executable = path.join(second, "codex")
      fs.writeFileSync(executable, "not executed", { mode: 0o755 })

      expect(
        detectCodexInstallations({
          platform: "linux",
          pathEnv: `${first}:${second}`,
          homeDir: directory,
          applicationDirs: [],
        }),
      ).toEqual([{ kind: "cli", path: executable, version: null }])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("finds supported macOS bundles only when the Codex resource exists", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-codex-"))
    try {
      const codexBundle = path.join(directory, "Codex.app")
      const chatGptBundle = path.join(directory, "ChatGPT.app")
      for (const bundle of [codexBundle, chatGptBundle]) {
        fs.mkdirSync(path.join(bundle, "Contents", "Resources"), {
          recursive: true,
        })
      }
      fs.writeFileSync(
        path.join(codexBundle, "Contents", "Resources", "codex"),
        "not executed",
        { mode: 0o755 },
      )

      expect(
        detectCodexInstallations({
          platform: "darwin",
          pathEnv: "",
          applicationDirs: [directory],
        }),
      ).toEqual([{ kind: "desktop", path: codexBundle, version: null }])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("Codex desktop and fallback detection", () => {
  test("deduplicates app scans and rejects symlinked bundles", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-codex-"))
    try {
      const applications = path.join(directory, "Applications")
      const links = path.join(directory, "Links")
      fs.mkdirSync(applications)
      fs.mkdirSync(links)
      const bundles = ["Codex.app", "ChatGPT.app"].map((name) =>
        path.join(applications, name),
      )
      for (const bundle of bundles) {
        const resources = path.join(bundle, "Contents", "Resources")
        fs.mkdirSync(resources, { recursive: true })
        fs.writeFileSync(path.join(resources, "codex"), "not executed", {
          mode: 0o755,
        })
      }
      fs.symlinkSync(bundles[0], path.join(links, "Codex.app"))

      expect(
        detectCodexInstallations({
          platform: "darwin",
          pathEnv: "",
          homeDir: directory,
          applicationDirs: [links, applications, applications],
        }),
      ).toEqual([
        { kind: "desktop", path: bundles[0], version: null },
        { kind: "desktop", path: bundles[1], version: null },
      ])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("checks user-local CLI locations when PATH is empty", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-codex-"))
    try {
      const bin = path.join(directory, ".local", "bin")
      fs.mkdirSync(bin, { recursive: true })
      const executable = path.join(bin, "codex")
      fs.writeFileSync(executable, "not executed", { mode: 0o755 })

      expect(
        detectCodexInstallations({
          platform: "linux",
          pathEnv: "",
          homeDir: directory,
          applicationDirs: [],
        }),
      ).toEqual([{ kind: "cli", path: executable, version: null }])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("checks npm-global and Windows APPDATA fallback locations", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-codex-"))
    try {
      const npmGlobal = path.join(directory, ".npm-global", "bin")
      const appData = path.join(directory, "AppData", "Roaming")
      const appDataNpm = path.join(appData, "npm")
      fs.mkdirSync(npmGlobal, { recursive: true })
      fs.mkdirSync(appDataNpm, { recursive: true })
      fs.writeFileSync(path.join(npmGlobal, "codex"), "not executed", {
        mode: 0o755,
      })
      fs.writeFileSync(path.join(appDataNpm, "codex.cmd"), "not executed")

      expect(
        detectCodexInstallations({
          platform: "linux",
          pathEnv: "",
          homeDir: directory,
        }),
      ).toContainEqual({
        kind: "cli",
        path: path.join(npmGlobal, "codex"),
        version: null,
      })
      expect(
        detectCodexInstallations({
          platform: "win32",
          pathEnv: "",
          homeDir: directory,
          appDataDir: appData,
        }),
      ).toContainEqual({
        kind: "cli",
        path: path.join(appDataNpm, "codex.cmd"),
        version: null,
      })
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("ignores empty PATH components instead of searching the working directory", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-codex-"))
    const previousCwd = process.cwd()
    try {
      fs.writeFileSync(path.join(directory, "codex"), "not executed", {
        mode: 0o755,
      })
      process.chdir(directory)

      expect(
        detectCodexInstallations({
          platform: "linux",
          pathEnv: ":",
          homeDir: path.join(directory, "home"),
        }),
      ).toEqual([])
    } finally {
      process.chdir(previousCwd)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("scans default user Applications only on macOS", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-codex-"))
    try {
      const bundle = path.join(directory, "Applications", "Codex.app")
      const resources = path.join(bundle, "Contents", "Resources")
      fs.mkdirSync(resources, { recursive: true })
      fs.writeFileSync(path.join(resources, "codex"), "not executed", {
        mode: 0o755,
      })

      expect(
        detectCodexInstallations({
          platform: "darwin",
          pathEnv: "",
          homeDir: directory,
        }),
      ).toContainEqual({ kind: "desktop", path: bundle, version: null })
      expect(
        detectCodexInstallations({
          platform: "linux",
          pathEnv: "",
          homeDir: directory,
          applicationDirs: [path.join(directory, "Applications")],
        }),
      ).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("finds Windows exe and npm cmd artifacts in paths with non-ASCII names", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-codex-"))
    try {
      const first = path.join(directory, "Program Files")
      const second = path.join(directory, "工具")
      fs.mkdirSync(first)
      fs.mkdirSync(second)
      fs.writeFileSync(path.join(first, "codex.exe"), "not executed")
      fs.writeFileSync(path.join(second, "codex.cmd"), "not executed")

      expect(
        detectCodexInstallations({
          platform: "win32",
          pathEnv: `${first};${second}`,
          applicationDirs: [],
        }),
      ).toEqual([
        { kind: "cli", path: path.join(first, "codex.exe"), version: null },
        { kind: "cli", path: path.join(second, "codex.cmd"), version: null },
      ])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
