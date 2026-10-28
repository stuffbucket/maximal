/**
 * The MCP server catalog: finding Work IQ's native executable wherever a
 * package manager put it, without relying on the caller's PATH resolving
 * `workiq` (a GUI-launched Maximal doesn't have the user's shell PATH).
 *
 * Every probe is injected (home, PATH, environment, npm prefix, mise dir,
 * fixed install prefixes), so nothing on this machine is read.
 */

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { McpCatalogEntry } from "~/lib/mcp-broker/catalog"

import {
  catalogServer,
  listMcpCatalog,
  mcpBrokerHealth,
  McpEndpointError,
  refreshCatalogCommands,
  setMcpEndpoint,
} from "~/apps/mcp"
import { getConfig, writeConfig } from "~/lib/config/config"
import { findCatalogEntry, WORKIQ_PACKAGE_SPEC } from "~/lib/mcp-broker/catalog"
import { resolveBrokerConfiguration } from "~/lib/mcp-broker/configuration"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-catalog-"))
let counter = 0
function tempDir(): string {
  const dir = path.join(root, String(counter++))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Lay down an `@microsoft/workiq` package with a fixture executable. */
function workiqPackage(
  packageDir: string,
  version: string,
  platformFolder = "osx-arm64",
): string {
  const bin = path.join(packageDir, "bin", platformFolder)
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "@microsoft/workiq", version }),
  )
  fs.writeFileSync(path.join(packageDir, "bin", "workiq.js"), "")
  const executable = path.join(bin, "workiq")
  fs.writeFileSync(executable, "#!/bin/sh\n")
  fs.chmodSync(executable, 0o755)
  return executable
}

function miseInstall(miseDir: string, version: string): string {
  return workiqPackage(
    path.join(
      miseDir,
      "installs",
      "npm-microsoft-workiq",
      version,
      "node_modules",
      "@microsoft",
      "workiq",
    ),
    version,
  )
}

function requireEntry(id: string): McpCatalogEntry {
  const entry = findCatalogEntry(id)
  if (!entry) throw new Error(`${id} missing from the catalog`)
  return entry
}

const workiq = requireEntry("workiq")

const base = {
  homeDir: "/nonexistent-home",
  pathDirs: [] as Array<string>,
  npmPrefix: null,
  npmLogin: null,
  platform: "darwin" as const,
  arch: "arm64",
  env: {},
  systemPrefixes: [] as Array<string>,
}

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
  writeConfig({})
})

describe("Work IQ locate", () => {
  test("finds the native executable in a mise install, not the shim", () => {
    const mise = tempDir()
    const executable = miseInstall(mise, "1.0.1")
    expect(workiq.locate({ ...base, miseDataDir: mise })).toEqual({
      command: executable,
      version: "1.0.1",
    })
  })

  test("prefers the newest mise version", () => {
    const mise = tempDir()
    miseInstall(mise, "0.9.0")
    const newest = miseInstall(mise, "1.10.0")
    miseInstall(mise, "1.2.0")
    expect(workiq.locate({ ...base, miseDataDir: mise })?.command).toBe(newest)
  })

  test("follows npm's global bin symlink on PATH into the package", () => {
    const prefix = tempDir()
    const packageDir = path.join(
      prefix,
      "lib",
      "node_modules",
      "@microsoft",
      "workiq",
    )
    const executable = workiqPackage(packageDir, "1.0.1")
    const binDir = path.join(prefix, "bin")
    fs.mkdirSync(binDir)
    fs.symlinkSync(
      path.join(packageDir, "bin", "workiq.js"),
      path.join(binDir, "workiq"),
    )
    expect(
      workiq.locate({ ...base, miseDataDir: tempDir(), pathDirs: [binDir] })
        ?.command,
    ).toBe(fs.realpathSync(executable))
  })

  test("finds a global npm install from the npm prefix", () => {
    const prefix = tempDir()
    const executable = workiqPackage(
      path.join(prefix, "lib", "node_modules", "@microsoft", "workiq"),
      "1.0.1",
    )
    expect(
      workiq.locate({ ...base, miseDataDir: tempDir(), npmPrefix: prefix })
        ?.command,
    ).toBe(executable)
  })

  test("not found: nothing installed, or no executable for this platform", () => {
    expect(workiq.locate({ ...base, miseDataDir: tempDir() })).toBeUndefined()
    const mise = tempDir()
    miseInstall(mise, "1.0.1")
    expect(
      workiq.locate({
        ...base,
        miseDataDir: mise,
        platform: "linux",
        arch: "x64",
      }),
    ).toBeUndefined()
  })

  test("the endpoint it writes runs the executable directly, off", () => {
    const server = workiq.template({
      command: "/abs/workiq",
      version: "1.0.1",
    })
    expect(server).toMatchObject({
      id: "workiq",
      enabled: false,
      catalog: "workiq",
      transport: { type: "stdio", command: "/abs/workiq", args: ["mcp"] },
      classification: { ownership: "exclusive" },
    })
  })
})

describe("Work IQ Linux keyring environment", () => {
  const install = { command: "/abs/workiq", version: "1.0.1" }
  const sessionBus = "unix:path=/fixture/user-bus"

  test("inherits the session bus through Linux catalog detection and resolution", () => {
    const prefix = tempDir()
    workiqPackage(
      path.join(prefix, "lib", "node_modules", "@microsoft", "workiq"),
      "1.0.1",
      "linux-x64",
    )
    const server = catalogServer("workiq", {
      ...base,
      platform: "linux",
      arch: "x64",
      npmPrefix: prefix,
      miseDataDir: tempDir(),
    })
    expect(server.environment).toEqual({
      inherit: ["HOME", "DBUS_SESSION_BUS_ADDRESS"],
    })
    expect(server.enabled).toBe(false)
    const { endpoints } = resolveBrokerConfiguration(
      { servers: [{ ...server, enabled: true }] },
      {
        HOME: "/fixture/home",
        DBUS_SESSION_BUS_ADDRESS: sessionBus,
        DISPLAY: ":fixture",
        GITHUB_TOKEN: "must-not-leak",
      },
    )
    expect(endpoints[0]?.environment).toEqual({
      HOME: "/fixture/home",
      DBUS_SESSION_BUS_ADDRESS: sessionBus,
    })
  })

  test("omits an unavailable session bus rather than inventing its value", () => {
    const server = workiq.template(install, { platform: "linux" })
    const { endpoints } = resolveBrokerConfiguration(
      { servers: [{ ...server, enabled: true }] },
      { HOME: "/fixture/home" },
    )
    expect(endpoints[0]?.environment).toEqual({ HOME: "/fixture/home" })
  })

  test.each(["darwin", "win32"] as const)(
    "keeps the existing environment policy on %s",
    (platform) => {
      const server = workiq.template(install, { platform })
      expect(server.environment).toEqual({ inherit: ["HOME"] })
      const { endpoints } = resolveBrokerConfiguration(
        { servers: [{ ...server, enabled: true }] },
        { HOME: "/fixture/home", DBUS_SESSION_BUS_ADDRESS: sessionBus },
      )
      expect(endpoints[0]?.environment).toEqual({ HOME: "/fixture/home" })
    },
  )

  test("defaults to the running platform without detection options", () => {
    expect(workiq.template(install).environment).toEqual({
      inherit:
        process.platform === "linux" ?
          ["HOME", "DBUS_SESSION_BUS_ADDRESS"]
        : ["HOME"],
    })
  })
})

describe("Work IQ locate across install methods", () => {
  test("picks the highest version, wherever it was installed", () => {
    const mise = tempDir()
    miseInstall(mise, "1.0.1")
    const prefix = tempDir()
    const npmNewer = workiqPackage(
      path.join(prefix, "lib", "node_modules", "@microsoft", "workiq"),
      "1.2.0",
    )
    expect(
      workiq.locate({ ...base, miseDataDir: mise, npmPrefix: prefix })?.command,
    ).toBe(npmNewer)
  })
})

describe("Work IQ install hint", () => {
  test("uses mise when mise manages tools here, npm otherwise", () => {
    const mise = tempDir()
    fs.mkdirSync(path.join(mise, "installs"))
    expect(workiq.install({ ...base, miseDataDir: mise }).command).toBe(
      "mise use -g npm:@microsoft/workiq@1",
    )
    expect(
      workiq.install({ ...base, miseDataDir: path.join(mise, "absent") })
        .command,
    ).toBe("npm install -g @microsoft/workiq@1")
  })
})

describe("listMcpCatalog", () => {
  test("offers catalog servers not added yet, with their status", () => {
    const mise = tempDir()
    const executable = miseInstall(mise, "1.0.1")
    const options = { ...base, miseDataDir: mise }
    const found = listMcpCatalog({}, options)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      id: "workiq",
      status: "ready",
      command: executable,
      version: "1.0.1",
    })
    const missing = listMcpCatalog({}, { ...base, miseDataDir: tempDir() })
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatchObject({ id: "workiq", status: "not-installed" })
    const added = {
      mcpBroker: {
        servers: [workiq.template({ command: executable, version: null })],
      },
    }
    expect(listMcpCatalog(added, options)).toEqual([])
  })
})

describe("refreshCatalogCommands", () => {
  test("re-finds a catalog server whose executable moved, and saves it", () => {
    const mise = tempDir()
    const moved = miseInstall(mise, "1.1.0")
    writeConfig({
      mcpBroker: {
        servers: [
          workiq.template({
            command: path.join(mise, "gone", "workiq"),
            version: null,
          }),
        ],
      },
    })
    const next = refreshCatalogCommands(getConfig(), {
      ...base,
      miseDataDir: mise,
    })
    expect(next.mcpBroker?.servers?.[0]?.transport.command).toBe(moved)
    expect(getConfig().mcpBroker?.servers?.[0]?.transport.command).toBe(moved)
  })

  test("switches to a newer install even while the old one is still there", () => {
    const mise = tempDir()
    const old = miseInstall(mise, "0.4.0")
    const newer = miseInstall(mise, "1.0.1")
    writeConfig({
      mcpBroker: {
        servers: [workiq.template({ command: old, version: "0.4.0" })],
      },
    })
    refreshCatalogCommands(getConfig(), { ...base, miseDataDir: mise })
    expect(getConfig().mcpBroker?.servers?.[0]?.transport.command).toBe(newer)
  })

  test("keeps the last path when the server was uninstalled", () => {
    writeConfig({
      mcpBroker: {
        servers: [workiq.template({ command: "/gone/workiq", version: null })],
      },
    })
    const before = getConfig()
    expect(
      refreshCatalogCommands(before, { ...base, miseDataDir: tempDir() }),
    ).toBe(before)
  })

  test("leaves the newest install and non-catalog servers alone", () => {
    const mise = tempDir()
    const executable = miseInstall(mise, "1.0.1")
    writeConfig({
      mcpBroker: {
        servers: [
          workiq.template({ command: executable, version: null }),
          {
            id: "custom",
            label: "Custom",
            transport: { type: "stdio", command: "/gone/custom" },
          },
        ],
      },
    })
    const before = getConfig()
    expect(refreshCatalogCommands(before, { ...base, miseDataDir: mise })).toBe(
      before,
    )
  })
})

// ── Installs a GUI-launched Maximal can't find through PATH or npm ──────

const PACKAGE_PATH = ["@microsoft", "workiq"] as const

/** npm's global layout under a Node install prefix (Unix). */
function npmGlobal(prefix: string, version: string, folder?: string): string {
  return workiqPackage(
    path.join(prefix, "lib", "node_modules", ...PACKAGE_PATH),
    version,
    folder,
  )
}

/** npm itself, which every Node install ships as a global package. */
function npmItself(prefix: string): void {
  const dir = path.join(prefix, "lib", "node_modules", "npm")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"npm"}')
}

/** A symlink as pnpm makes them: relative to the link's directory. */
function relativeLink(target: string, link: string): void {
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(path.relative(path.dirname(link), target), link)
}

/** pnpm ≤10: `global/5/node_modules/@microsoft/workiq` links into `.pnpm`. */
function pnpm10Install(home: string, version: string, folder?: string): string {
  const modules = path.join(home, "global", "5", "node_modules")
  const real = path.join(
    modules,
    ".pnpm",
    `@microsoft+workiq@${version}`,
    "node_modules",
    ...PACKAGE_PATH,
  )
  const executable = workiqPackage(real, version, folder)
  relativeLink(real, path.join(modules, ...PACKAGE_PATH))
  return fs.realpathSync(executable)
}

/** pnpm ≥11: each global install is a project under `global/v11/`, with a
 *  hash-named symlink to it, and the package links into the shared store. */
function pnpm11Install(home: string, version: string): string {
  const real = path.join(
    home,
    "store",
    "v11",
    "links",
    ...PACKAGE_PATH,
    version,
    "f00d",
    "node_modules",
    ...PACKAGE_PATH,
  )
  const executable = workiqPackage(real, version)
  const project = `c31c-${version}`
  relativeLink(
    real,
    path.join(home, "global", "v11", project, "node_modules", ...PACKAGE_PATH),
  )
  fs.symlinkSync(project, path.join(home, "global", "v11", `hash-${version}`))
  return fs.realpathSync(executable)
}

describe("Work IQ locate: pnpm global installs", () => {
  test("follows pnpm 10's symlinked package", () => {
    const pnpmHome = tempDir()
    const executable = pnpm10Install(pnpmHome, "1.0.1")
    expect(
      workiq.locate({
        ...base,
        miseDataDir: tempDir(),
        env: { PNPM_HOME: pnpmHome },
      }),
    ).toEqual({ command: executable, version: "1.0.1" })
  })

  test("follows pnpm 11's hash-linked projects into the store", () => {
    const pnpmHome = tempDir()
    pnpm11Install(pnpmHome, "1.0.1")
    const newer = pnpm11Install(pnpmHome, "1.1.0")
    expect(
      workiq.locate({
        ...base,
        miseDataDir: tempDir(),
        env: { PNPM_HOME: pnpmHome },
      }),
    ).toEqual({ command: newer, version: "1.1.0" })
  })

  test("finds pnpm's home without PNPM_HOME, per platform", () => {
    const home = tempDir()
    const mac = pnpm10Install(path.join(home, "Library", "pnpm"), "1.0.1")
    expect(
      workiq.locate({ ...base, homeDir: home, miseDataDir: tempDir() })
        ?.command,
    ).toBe(mac)

    const linuxHome = tempDir()
    const linux = pnpm10Install(
      path.join(linuxHome, ".local", "share", "pnpm"),
      "1.0.1",
      "linux-x64",
    )
    const linuxOptions = {
      ...base,
      platform: "linux" as const,
      arch: "x64",
      miseDataDir: tempDir(),
    }
    expect(
      workiq.locate({ ...linuxOptions, homeDir: linuxHome })?.command,
    ).toBe(linux)

    const xdg = tempDir()
    const fromXdg = pnpm10Install(path.join(xdg, "pnpm"), "1.0.1", "linux-x64")
    expect(
      workiq.locate({
        ...linuxOptions,
        homeDir: tempDir(),
        env: { XDG_DATA_HOME: xdg },
      })?.command,
    ).toBe(fromXdg)
  })
})

type DetectOptions = Parameters<typeof workiq.locate>[0]

/** Where Work IQ is found, with no mise installs unless given. */
function located(options: DetectOptions): string | undefined {
  return workiq.locate({ ...base, miseDataDir: tempDir(), ...options })?.command
}

/** The install hint's command, with no mise unless given. */
function hint(options: DetectOptions): string {
  return workiq.install({ ...base, miseDataDir: tempDir(), ...options }).command
}

/** The registry host the install hint names. */
function registry(options: DetectOptions): string | null {
  return workiq.install({ ...base, miseDataDir: tempDir(), ...options })
    .registry
}

function homeWithNpmrc(contents: string): string {
  const home = tempDir()
  fs.writeFileSync(path.join(home, ".npmrc"), contents)
  return home
}

describe("Work IQ locate: Node installs outside PATH", () => {
  test("Homebrew and other fixed prefixes", () => {
    const brew = tempDir()
    const executable = npmGlobal(brew, "1.0.1")
    expect(located({ systemPrefixes: ["/nonexistent", brew] })).toBe(executable)
  })

  test("every nvm version, newest Work IQ first", () => {
    const nvm = tempDir()
    const versions = path.join(nvm, "versions", "node")
    npmGlobal(path.join(versions, "v20.11.0"), "1.0.1")
    const newer = npmGlobal(path.join(versions, "v22.3.0"), "1.2.0")
    expect(located({ env: { NVM_DIR: nvm } })).toBe(newer)

    const home = tempDir()
    const fromDefault = npmGlobal(
      path.join(home, ".nvm", "versions", "node", "v22.3.0"),
      "1.0.1",
    )
    expect(located({ homeDir: home })).toBe(fromDefault)
  })

  test("fnm, asdf, Volta, and mise-managed Node", () => {
    const fnm = tempDir()
    const viaFnm = npmGlobal(
      path.join(fnm, "node-versions", "v22.3.0", "installation"),
      "1.0.1",
    )
    expect(located({ env: { FNM_DIR: fnm } })).toBe(viaFnm)

    const fnmHome = tempDir()
    const viaMacFnm = npmGlobal(
      path.join(
        fnmHome,
        "Library",
        "Application Support",
        "fnm",
        "node-versions",
        "v22.3.0",
        "installation",
      ),
      "1.0.1",
    )
    expect(located({ homeDir: fnmHome })).toBe(viaMacFnm)

    const asdf = tempDir()
    const viaAsdf = npmGlobal(
      path.join(asdf, "installs", "nodejs", "22.3.0"),
      "1.0.1",
    )
    expect(located({ env: { ASDF_DATA_DIR: asdf } })).toBe(viaAsdf)

    const volta = tempDir()
    const viaVolta = npmGlobal(
      path.join(volta, "tools", "image", "packages", ...PACKAGE_PATH),
      "1.0.1",
    )
    expect(located({ env: { VOLTA_HOME: volta } })).toBe(viaVolta)

    const mise = tempDir()
    const viaMiseNode = npmGlobal(
      path.join(mise, "installs", "node", "22.3.0"),
      "1.0.1",
    )
    expect(located({ miseDataDir: mise })).toBe(viaMiseNode)
  })

  test("npm's prefix from the environment or ~/.npmrc, without running npm", () => {
    const home = tempDir()
    const viaDefault = npmGlobal(path.join(home, ".npm-global"), "1.0.1")
    expect(located({ homeDir: home })).toBe(viaDefault)

    const envPrefix = tempDir()
    const viaEnv = npmGlobal(envPrefix, "1.0.1")
    expect(located({ env: { NPM_CONFIG_PREFIX: envPrefix } })).toBe(viaEnv)
    expect(located({ env: { npm_config_prefix: envPrefix } })).toBe(viaEnv)

    const rcHome = tempDir()
    const viaTilde = npmGlobal(path.join(rcHome, "tools", "npm"), "1.0.1")
    fs.writeFileSync(
      path.join(rcHome, ".npmrc"),
      "; user settings\nprefix = ~/tools/npm\n",
    )
    expect(located({ homeDir: rcHome })).toBe(viaTilde)

    const userconfig = path.join(tempDir(), "custom.npmrc")
    const absolute = tempDir()
    const viaUserconfig = npmGlobal(absolute, "1.0.1")
    fs.writeFileSync(userconfig, `prefix="${absolute}"\n`)
    expect(located({ env: { NPM_CONFIG_USERCONFIG: userconfig } })).toBe(
      viaUserconfig,
    )
  })

  test("npm's Windows global folder under %APPDATA%", () => {
    const appData = tempDir()
    const packageDir = path.join(
      appData,
      "npm",
      "node_modules",
      ...PACKAGE_PATH,
    )
    const bin = path.join(packageDir, "bin", "win-x64")
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      '{"version":"1.0.1"}',
    )
    fs.writeFileSync(path.join(bin, "workiq.exe"), "")
    expect(
      located({ platform: "win32", arch: "x64", env: { APPDATA: appData } }),
    ).toBe(path.join(bin, "workiq.exe"))
  })
})

describe("Work IQ install hint: package manager", () => {
  test("pins the major version Maximal knows the layout of", () => {
    expect(WORKIQ_PACKAGE_SPEC).toBe("@microsoft/workiq@1")
  })

  test("pnpm when pnpm has global installs and no npm can be found", () => {
    const pnpmHome = tempDir()
    fs.mkdirSync(path.join(pnpmHome, "global"))
    expect(hint({ env: { PNPM_HOME: pnpmHome } })).toBe(
      "pnpm add -g @microsoft/workiq@1",
    )
  })

  test("npm when npm can be found, even with pnpm around", () => {
    const pnpmHome = tempDir()
    fs.mkdirSync(path.join(pnpmHome, "global"))
    const brew = tempDir()
    npmItself(brew)
    expect(hint({ env: { PNPM_HOME: pnpmHome }, systemPrefixes: [brew] })).toBe(
      "npm install -g @microsoft/workiq@1",
    )
    const bin = tempDir()
    fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\n")
    fs.chmodSync(path.join(bin, "npm"), 0o755)
    expect(hint({ env: { PNPM_HOME: pnpmHome }, pathDirs: [bin] })).toBe(
      "npm install -g @microsoft/workiq@1",
    )
  })

  test("mise before pnpm", () => {
    const pnpmHome = tempDir()
    fs.mkdirSync(path.join(pnpmHome, "global"))
    const mise = tempDir()
    fs.mkdirSync(path.join(mise, "installs"))
    expect(hint({ env: { PNPM_HOME: pnpmHome }, miseDataDir: mise })).toBe(
      "mise use -g npm:@microsoft/workiq@1",
    )
  })
})

describe("Work IQ install hint: registry", () => {
  test("no host is claimed when nothing confirms one", () => {
    expect(registry({})).toBeNull()
  })

  test("NPM_CONFIG_USERCONFIG replaces ~/.npmrc", () => {
    const home = homeWithNpmrc("registry=https://home.example.test/\n")
    const custom = path.join(tempDir(), "npmrc")
    fs.writeFileSync(custom, "registry=https://custom.example.test/\n")
    expect(
      registry({ homeDir: home, env: { NPM_CONFIG_USERCONFIG: custom } }),
    ).toBe("custom.example.test")
  })

  test("a @microsoft scope registry wins over every plain registry in files and env", () => {
    const home = homeWithNpmrc(
      [
        "registry=https://plain.example.test/",
        "@microsoft:registry=https://scoped.example.test/npm/",
      ].join("\n"),
    )
    expect(
      registry({
        homeDir: home,
        env: { NPM_CONFIG_REGISTRY: "https://env.example.test/" },
      }),
    ).toBe("scoped.example.test")
  })

  test("Maximal's npmRegistry setting goes into the command", () => {
    const npmRegistry = "https://mirror.example.test/npm/"
    expect(
      workiq.install({ ...base, miseDataDir: tempDir(), npmRegistry }),
    ).toMatchObject({
      command: `npm install -g @microsoft/workiq@1 --registry ${npmRegistry}`,
      registry: "mirror.example.test",
    })

    const mise = tempDir()
    fs.mkdirSync(path.join(mise, "installs"))
    expect(
      workiq.install({ ...base, miseDataDir: mise, npmRegistry }).command,
    ).toBe(
      `NPM_CONFIG_REGISTRY=${npmRegistry} mise use -g npm:@microsoft/workiq@1`,
    )

    const pnpmHome = tempDir()
    fs.mkdirSync(path.join(pnpmHome, "global"))
    expect(
      workiq.install({
        ...base,
        miseDataDir: tempDir(),
        env: { PNPM_HOME: pnpmHome },
        npmRegistry,
      }).command,
    ).toBe(`pnpm add -g @microsoft/workiq@1 --registry ${npmRegistry}`)

    expect(
      workiq.install({
        ...base,
        miseDataDir: tempDir(),
        npmRegistry: "https://mirror.example.test/npm?a=1&b=2",
      }).command,
    ).toBe(
      "npm install -g @microsoft/workiq@1 --registry 'https://mirror.example.test/npm?a=1&b=2'",
    )
  })

  test("listMcpCatalog passes the setting from config.json", () => {
    const [item] = listMcpCatalog(
      {
        mcpBroker: {
          catalog: { npmRegistry: "https://mirror.example.test/" },
        },
      },
      { ...base, miseDataDir: tempDir() },
    )
    expect(item.install).toMatchObject({
      command:
        "npm install -g @microsoft/workiq@1 --registry https://mirror.example.test/",
      registry: "mirror.example.test",
    })
  })
})

describe("on Windows, where the MCP broker can't run yet", () => {
  test("offers no server to install or add", () => {
    expect(
      listMcpCatalog(
        {},
        { ...base, platform: "win32", arch: "x64", miseDataDir: tempDir() },
      ),
    ).toEqual([])
  })

  test("reports the broker unavailable even while it is off", () => {
    expect(mcpBrokerHealth("win32")).toEqual({
      state: "unavailable",
      problem: "unsupported-platform",
    })
  })

  test("refuses to turn an endpoint on, and changes nothing", async () => {
    const calls: Array<string> = []
    writeConfig({
      mcpBroker: {
        servers: [workiq.template({ command: "/abs/workiq", version: null })],
      },
    })
    const steps = {
      platform: "win32" as const,
      reconfigure: () => {
        calls.push("reconfigure")
        return Promise.resolve(true)
      },
      waitForBroker: () => {
        calls.push("wait")
        return Promise.resolve("ready" as const)
      },
      syncClients: () => {
        calls.push("sync")
        return Promise.resolve([])
      },
    }
    let thrown: unknown
    try {
      await setMcpEndpoint(
        "workiq",
        { enabled: true, clients: ["claude-code"] },
        steps,
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(McpEndpointError)
    expect(thrown).toMatchObject({ code: "unsupported-platform" })
    expect(calls).toEqual([])
    expect(getConfig().mcpBroker?.servers?.[0]?.enabled).toBe(false)
    expect(getConfig().mcpBroker?.servers?.[0]?.clients).toBeUndefined()

    // Turning one off still works, so nothing is stuck on.
    const off = await setMcpEndpoint("workiq", { enabled: false }, steps)
    expect(off?.endpoint.enabled).toBe(false)
  })
})

describe("docs/linux-workiq.md", () => {
  test("installs the same major version as the hint", () => {
    const doc = fs.readFileSync(
      path.join(import.meta.dir, "..", "docs", "linux-workiq.md"),
      "utf8",
    )
    expect(doc).toContain(`mise use --global npm:${WORKIQ_PACKAGE_SPEC}\n`)
    expect(doc).toContain(`npm install --global ${WORKIQ_PACKAGE_SPEC}\n`)
    expect(doc).toContain(`pnpm add --global ${WORKIQ_PACKAGE_SPEC}\n`)
    expect(doc).not.toMatch(/(?:use|install|add) --global \S+@1\.0\.1/u)
  })
})
