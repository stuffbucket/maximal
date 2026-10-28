/**
 * npm's registry and prefix as the user's login environment reports them.
 * The runner is injected (no real shell) except in the one integration test.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { findCatalogEntry } from "~/lib/mcp-broker/catalog"
import {
  __resetNpmLoginForTests,
  __setNpmLoginDepsForTests,
  cachedNpmLoginConfig,
  npmLoginConfig,
  parseNpmLoginOutput,
} from "~/lib/system/npm-login-config"
import { type RunResult, runFile } from "~/lib/system/run-file"

const ok = (stdout: string): RunResult => ({
  stdout,
  stderr: "",
  code: 0,
  notFound: false,
})
const killed: RunResult = {
  stdout: "",
  stderr: "",
  code: 1,
  notFound: false,
}
const missing: RunResult = {
  stdout: "",
  stderr: "",
  code: 127,
  notFound: true,
}
const NONE = { registry: null, scopeRegistry: null, prefix: null }

beforeEach(() => {
  __resetNpmLoginForTests()
})
afterEach(() => {
  __resetNpmLoginForTests()
})

describe("parseNpmLoginOutput", () => {
  test("three lines are registry, scope registry, prefix", () => {
    expect(
      parseNpmLoginOutput(
        "https://proxy.example.test/npm/\nhttps://scope.example.test/\n/opt/node\n",
      ),
    ).toEqual({
      registry: "https://proxy.example.test/npm/",
      scopeRegistry: "https://scope.example.test/",
      prefix: "/opt/node",
    })
  })

  test("npm's literal undefined and empty lines are null", () => {
    expect(
      parseNpmLoginOutput("https://r.example.test/\nundefined\n/usr/local\n"),
    ).toEqual({
      registry: "https://r.example.test/",
      scopeRegistry: null,
      prefix: "/usr/local",
    })
    expect(parseNpmLoginOutput("undefined\n\n\n")).toEqual(NONE)
    expect(parseNpmLoginOutput("")).toEqual(NONE)
  })

  test("a login banner before the answers is ignored; a short output is not trusted", () => {
    expect(parseNpmLoginOutput("Welcome\nr\ns\np\n")).toEqual({
      registry: "r",
      scopeRegistry: "s",
      prefix: "p",
    })
    expect(parseNpmLoginOutput("r\ns\n")).toEqual(NONE)
  })
})

describe("npmLoginConfig", () => {
  test("runs the login shell with one fixed script, and caches the answer", async () => {
    const calls: Array<{
      file: string
      args: Array<string>
      closeStdin?: boolean
    }> = []
    let now = 0
    __setNpmLoginDepsForTests({
      platform: "darwin",
      env: { SHELL: "/bin/fish" },
      now: () => now,
      run: (file, args, options) => {
        calls.push({ file, args, closeStdin: options.closeStdin })
        return Promise.resolve(ok("https://r.example.test/\nundefined\n/p\n"))
      },
    })
    expect(cachedNpmLoginConfig()).toBeUndefined()
    const [a, b] = await Promise.all([npmLoginConfig(), npmLoginConfig()])
    expect(a).toEqual(b)
    expect(cachedNpmLoginConfig()).toEqual({
      registry: "https://r.example.test/",
      scopeRegistry: null,
      prefix: "/p",
    })
    expect(calls).toEqual([
      {
        file: "/bin/fish",
        args: [
          "-lic",
          "npm config get registry; npm config get @microsoft:registry; npm prefix -g",
        ],
        closeStdin: true,
      },
    ])
    now += 5 * 60_000
    await npmLoginConfig()
    expect(calls).toHaveLength(1)
  })

  test("refreshes in the background after ten minutes, serving the old answer", async () => {
    let now = 0
    let registry = "https://one.example.test/"
    __setNpmLoginDepsForTests({
      platform: "linux",
      env: { SHELL: "/bin/bash" },
      now: () => now,
      run: () => Promise.resolve(ok(`${registry}\nundefined\n/p\n`)),
    })
    expect((await npmLoginConfig()).registry).toBe("https://one.example.test/")
    registry = "https://two.example.test/"
    now += 10 * 60_000
    expect((await npmLoginConfig()).registry).toBe("https://one.example.test/")
    await Bun.sleep(5)
    expect(cachedNpmLoginConfig()?.registry).toBe("https://two.example.test/")
  })

  test("a timeout gives all-null, retried after a minute", async () => {
    let now = 0
    let runs = 0
    __setNpmLoginDepsForTests({
      platform: "linux",
      env: { SHELL: "/bin/bash" },
      now: () => now,
      run: () => {
        runs++
        return Promise.resolve(runs === 1 ? killed : ok("r\nundefined\np\n"))
      },
    })
    expect(await npmLoginConfig()).toEqual(NONE)
    now += 30_000
    expect(await npmLoginConfig()).toEqual(NONE)
    expect(runs).toBe(1)
    now += 31_000
    await npmLoginConfig()
    await Bun.sleep(5)
    expect(cachedNpmLoginConfig()).toEqual({
      registry: "r",
      scopeRegistry: null,
      prefix: "p",
    })
  })

  test("without SHELL it tries /bin/zsh on macOS, then /bin/sh", async () => {
    const files: Array<string> = []
    __setNpmLoginDepsForTests({
      platform: "darwin",
      env: {},
      run: (file) => {
        files.push(file)
        return Promise.resolve(file === "/bin/sh" ? ok("r\ns\np\n") : missing)
      },
    })
    expect((await npmLoginConfig()).prefix).toBe("p")
    expect(files).toEqual(["/bin/zsh", "/bin/sh"])
  })

  test("on Windows it runs npm.cmd directly, one question each", async () => {
    const calls: Array<string> = []
    const answers: Record<string, string> = {
      "config get registry": "https://win.example.test/\n",
      "config get @microsoft:registry": "undefined\n",
      "prefix -g": "C:\\Users\\u\\AppData\\Roaming\\npm\n",
    }
    __setNpmLoginDepsForTests({
      platform: "win32",
      env: {},
      run: (file, args) => {
        calls.push(file)
        return Promise.resolve(ok(answers[args.join(" ")] ?? ""))
      },
    })
    expect(await npmLoginConfig()).toEqual({
      registry: "https://win.example.test/",
      scopeRegistry: null,
      prefix: String.raw`C:\Users\u\AppData\Roaming\npm`,
    })
    expect(new Set(calls)).toEqual(new Set(["npm.cmd"]))
    expect(calls).toHaveLength(3)
  })
})

const workiq = findCatalogEntry("workiq")
const noInstall = {
  homeDir: "/nonexistent-home",
  pathDirs: [] as Array<string>,
  npmPrefix: null,
  platform: "darwin" as const,
  arch: "arm64",
  env: {},
  systemPrefixes: [] as Array<string>,
}
const dirs: Array<string> = []
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-login-"))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})
const login = (scopeRegistry: string | null, registry: string | null) => ({
  registry,
  scopeRegistry,
  prefix: null,
})
const hostFor = (options: Record<string, unknown>) =>
  workiq?.install({
    ...noInstall,
    miseDataDir: tempDir(),
    ...options,
  }).registry

describe("Work IQ install hint with npm's login-environment answer", () => {
  test("is null when nothing confirms a registry", () => {
    expect(hostFor({ npmLogin: null })).toBeNull()
    expect(hostFor({ npmLogin: login(null, null) })).toBeNull()
  })

  test("beats files and env; Maximal's setting beats it", () => {
    const home = tempDir()
    fs.writeFileSync(
      path.join(home, ".npmrc"),
      "registry=https://user.example.test/npm/\n",
    )
    const env = { NPM_CONFIG_REGISTRY: "https://env.example.test/" }
    const both = login(
      "https://scope.example.test/",
      "https://plain.example.test/",
    )
    expect(
      hostFor({
        homeDir: home,
        env,
        npmLogin: login(null, "https://plain.example.test/"),
      }),
    ).toBe("plain.example.test")
    expect(hostFor({ homeDir: home, env, npmLogin: both })).toBe(
      "scope.example.test",
    )
    expect(
      hostFor({
        homeDir: home,
        env,
        npmLogin: both,
        npmRegistry: "https://maximal.example.test/",
      }),
    ).toBe("maximal.example.test")
    // An answer with nothing in it falls back to env, then files.
    expect(hostFor({ homeDir: home, env, npmLogin: login(null, null) })).toBe(
      "env.example.test",
    )
    expect(hostFor({ homeDir: home, npmLogin: null })).toBe("user.example.test")
  })

  test("npm's global prefix is used for detection", () => {
    const prefix = tempDir()
    const dir = path.join(prefix, "lib", "node_modules", "@microsoft", "workiq")
    fs.mkdirSync(path.join(dir, "bin", "osx-arm64"), { recursive: true })
    fs.writeFileSync(path.join(dir, "package.json"), '{"version":"1.0.0"}')
    const exe = path.join(dir, "bin", "osx-arm64", "workiq")
    fs.writeFileSync(exe, "#!/bin/sh\n")
    fs.chmodSync(exe, 0o755)
    const { npmPrefix: _unset, ...rest } = noInstall
    const found = workiq?.locate({
      ...rest,
      miseDataDir: tempDir(),
      npmLogin: { registry: null, scopeRegistry: null, prefix },
    })
    expect(found?.command).toBe(exe)
  })
})

const shell = process.env.SHELL ?? ""
const npmOnLoginPath =
  process.platform !== "win32"
  && shell !== ""
  && spawnSync(shell, ["-lic", "command -v npm"], {
    stdio: "ignore",
    timeout: 4000,
  }).status === 0

describe("the real login shell", () => {
  test.skipIf(!npmOnLoginPath)(
    "returns what npm reports for this user",
    async () => {
      __setNpmLoginDepsForTests({ run: runFile })
      const result = await npmLoginConfig()
      expect(result.registry).toMatch(/^https?:\/\//u)
      expect(result.prefix).toBeTruthy()
    },
    10_000,
  )
})
