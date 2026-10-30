import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  devConfig,
  prepareAppDev,
  resolveDevProfile,
  resolveTauriAppDataDir,
  resolveWorktreeId,
  stopPriorDevSession,
} from "../scripts/app-dev-prepare"

const REPO_ROOT = path.resolve(import.meta.dir, "..")
const SAFE_IDENTIFIER_COMPONENT = /^[a-z_][\w-]*$/i
const temporaryDirectories: Array<string> = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "maximal-app-dev-"))
  temporaryDirectories.push(directory)
  return directory
}

function git(cwd: string, ...args: Array<string>): string {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString())
  }
  return result.stdout.toString().trim()
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("app:dev worktree identity", () => {
  test("persists a random ID in the worktree-specific Git admin directory", () => {
    const repo = temporaryDirectory()
    git(repo, "init", "--quiet")

    let generated = 0
    const first = resolveWorktreeId(repo, () => {
      generated += 1
      return "a1b2c3d4e5f6"
    })
    const again = resolveWorktreeId(repo, () => {
      generated += 1
      return "000000000000"
    })

    const idFile = git(
      repo,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "maximal-worktree-id",
    )
    expect(first).toBe("a1b2c3d4e5f6")
    expect(again).toBe(first)
    expect(generated).toBe(1)
    expect(readFileSync(idFile, "utf8")).toBe("a1b2c3d4e5f6\n")
  })

  test("uses the identifier's Tauri app-data directory by default", () => {
    const profile = resolveDevProfile({}, "a1b2c3d4e5f6", {
      platform: "linux",
      homedir: "/home/tester",
    })

    expect(profile).toEqual({
      home: path.join(
        "/home/tester",
        ".local",
        "share",
        "co.stuffbucket.maximal.dev.maximal-a1b2c3d4e5f6",
      ),
      identifier: "co.stuffbucket.maximal.dev.maximal-a1b2c3d4e5f6",
      worktreeId: "a1b2c3d4e5f6",
    })
  })

  test("uses D-Bus-safe components in the generated identifier", () => {
    const { identifier } = resolveDevProfile({}, "0123456789ab", {
      platform: "linux",
      homedir: "/home/tester",
    })

    for (const component of identifier.split(".")) {
      expect(component).toMatch(SAFE_IDENTIFIER_COMPONENT)
    }
  })

  test("resolves Tauri app data on every desktop platform", () => {
    const identifier = "co.stuffbucket.maximal.dev.maximal-a1b2c3d4e5f6"
    expect(
      resolveTauriAppDataDir(identifier, {
        platform: "win32",
        homedir: String.raw`C:\Users\tester`,
        appData: String.raw`D:\Roaming`,
      }),
    ).toBe(path.win32.join(String.raw`D:\Roaming`, identifier))
    expect(
      resolveTauriAppDataDir(identifier, {
        platform: "darwin",
        homedir: "/Users/tester",
      }),
    ).toBe(
      path.posix.join(
        "/Users/tester",
        "Library",
        "Application Support",
        identifier,
      ),
    )
    expect(
      resolveTauriAppDataDir(identifier, {
        platform: "linux",
        homedir: "/home/tester",
        xdgDataHome: "/data/tester",
      }),
    ).toBe(path.posix.join("/data/tester", identifier))
  })

  test("preserves an explicit COPILOT_API_HOME", () => {
    const profile = resolveDevProfile(
      { COPILOT_API_HOME: "relative/dev-home" },
      "a1b2c3d4e5f6",
      { platform: "linux", homedir: "/home/tester" },
    )

    expect(profile.home).toBe("relative/dev-home")
  })
})

describe("app:dev prior session", () => {
  const identifier = "co.stuffbucket.maximal.dev.maximal-a1b2c3d4e5f6"

  test("shuts down the recorded sidecar and waits for it and its shell", async () => {
    const home = temporaryDirectory()
    writeFileSync(
      path.join(home, "session-running"),
      JSON.stringify({
        pid: 101,
        port: 4199,
        parentPid: 202,
        instanceId: identifier,
      }),
    )
    const alive = new Set([101, 202])
    const shutdownPorts: Array<number> = []
    let now = 0

    const stopped = await stopPriorDevSession(home, identifier, {
      processIsAlive: (pid) => alive.has(pid),
      requestShutdown: (port) => {
        shutdownPorts.push(port)
        alive.delete(101)
        return Promise.resolve()
      },
      sleep: () => {
        alive.delete(202)
        now += 100
        return Promise.resolve()
      },
      now: () => now,
    })

    expect(stopped).toBe(true)
    expect(shutdownPorts).toEqual([4199])
    expect(alive.size).toBe(0)
  })

  test("does nothing without a live recorded session", async () => {
    expect(
      await stopPriorDevSession(temporaryDirectory(), identifier, {
        processIsAlive: () => false,
        requestShutdown: () => {
          throw new Error("must not request shutdown")
        },
        sleep: () => Promise.resolve(),
        now: () => 0,
      }),
    ).toBe(false)
  })

  test("waits for a failed development shell to exit itself", async () => {
    const home = temporaryDirectory()
    writeFileSync(
      path.join(home, "session-running"),
      JSON.stringify({
        pid: 101,
        port: 4199,
        parentPid: 202,
        instanceId: identifier,
      }),
    )
    const alive = new Set([202])
    let now = 0

    expect(
      await stopPriorDevSession(home, identifier, {
        processIsAlive: (pid) => alive.has(pid),
        requestShutdown: () => {
          throw new Error("dead sidecar must not receive shutdown")
        },
        sleep: () => {
          alive.delete(202)
          now += 100
          return Promise.resolve()
        },
        now: () => now,
      }),
    ).toBe(true)
  })

  test("does not stop a sentinel belonging to another profile", async () => {
    const home = temporaryDirectory()
    writeFileSync(
      path.join(home, "session-running"),
      JSON.stringify({
        pid: 101,
        port: 4199,
        instanceId: "co.stuffbucket.maximal.dev.maximal-different",
      }),
    )

    expect(
      await stopPriorDevSession(home, identifier, {
        processIsAlive: () => true,
        requestShutdown: () => {
          throw new Error("must not request shutdown")
        },
        sleep: () => Promise.resolve(),
        now: () => 0,
      }),
    ).toBe(false)
  })
})

describe("app:dev Tauri config", () => {
  test("contains the worktree-specific app identity", () => {
    expect(
      devConfig("co.stuffbucket.maximal.dev.maximal-a1b2c3d4e5f6"),
    ).toEqual({
      identifier: "co.stuffbucket.maximal.dev.maximal-a1b2c3d4e5f6",
      productName: "Maximal Dev",
    })
  })

  test("writes generated config below the ignored Tauri target directory", () => {
    const repo = temporaryDirectory()
    git(repo, "init", "--quiet")
    const prepared = prepareAppDev({}, repo)

    expect(prepared.configPath).toBe(
      path.join(
        repo,
        "shell",
        "src-tauri",
        "target",
        "maximal-config",
        "tauri.dev.conf.json",
      ),
    )
    expect(
      JSON.parse(readFileSync(prepared.configPath, "utf8")) as unknown,
    ).toEqual({
      identifier: prepared.identifier,
      productName: "Maximal Dev",
    })
    expect("COPILOT_API_HOME" in prepared.env).toBe(false)
  })

  test("passes an explicit COPILOT_API_HOME through unchanged", () => {
    const repo = temporaryDirectory()
    git(repo, "init", "--quiet")
    const prepared = prepareAppDev(
      { COPILOT_API_HOME: "relative/dev-home" },
      repo,
    )

    const expected = path.join(repo, "relative", "dev-home")
    expect(prepared.env.COPILOT_API_HOME).toBe(expected)
    expect(prepared.home).toBe(expected)
  })

  test("keeps test builds separate from the production Tauri identity", () => {
    const testConfig = JSON.parse(
      readFileSync(
        path.join(REPO_ROOT, "shell", "src-tauri", "tauri.test.conf.json"),
        "utf8",
      ),
    ) as { identifier?: string; productName?: string }
    const packageJson = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> }

    expect(testConfig.identifier).toBe("co.stuffbucket.maximal.test")
    for (const component of testConfig.identifier?.split(".") ?? []) {
      expect(component).toMatch(SAFE_IDENTIFIER_COMPONENT)
    }
    expect(testConfig.productName).toBe("Maximal Test")
    expect(packageJson.scripts?.["app:build:test"]).toContain(
      "src-tauri/tauri.test.conf.json",
    )
  })
})
