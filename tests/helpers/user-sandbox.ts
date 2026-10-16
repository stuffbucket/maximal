import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const ROOT_ENV = "MAXIMAL_TEST_USER_ROOT"

const DIRECTORY_ENV_NAMES = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "COPILOT_API_HOME",
  "CLAUDE_CONFIG_DIR",
  "MISE_CONFIG_DIR",
  "MISE_DATA_DIR",
  "MISE_CACHE_DIR",
  "MISE_STATE_DIR",
  "TMPDIR",
  "TMP",
  "TEMP",
] as const

const WINDOWS_HOME_ENV_NAMES = ["HOMEDRIVE", "HOMEPATH"] as const
const SANDBOX_ENV_NAMES = [
  ...DIRECTORY_ENV_NAMES,
  ...WINDOWS_HOME_ENV_NAMES,
] as const

type SandboxEnvName = (typeof SANDBOX_ENV_NAMES)[number]

export interface TestUserSandbox {
  root: string
  env: Record<SandboxEnvName, string>
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
}

export function createTestUserSandbox(): TestUserSandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-test-user-"))
  const home = path.join(root, "home")
  const temp = path.join(root, "tmp")
  const homeRoot = path.parse(home).root
  const homeDrive = homeRoot.slice(0, -1) || homeRoot
  const homePath = `${path.sep}${path.relative(homeRoot, home)}`
  const env: Record<SandboxEnvName, string> = {
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: homeDrive,
    HOMEPATH: homePath,
    XDG_CONFIG_HOME: path.join(root, "xdg", "config"),
    XDG_DATA_HOME: path.join(root, "xdg", "data"),
    XDG_CACHE_HOME: path.join(root, "xdg", "cache"),
    XDG_STATE_HOME: path.join(root, "xdg", "state"),
    APPDATA: path.join(root, "windows", "roaming"),
    LOCALAPPDATA: path.join(root, "windows", "local"),
    COPILOT_API_HOME: path.join(root, "maximal"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    MISE_CONFIG_DIR: path.join(root, "mise", "config"),
    MISE_DATA_DIR: path.join(root, "mise", "data"),
    MISE_CACHE_DIR: path.join(root, "mise", "cache"),
    MISE_STATE_DIR: path.join(root, "mise", "state"),
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
  }

  for (const name of DIRECTORY_ENV_NAMES) {
    fs.mkdirSync(env[name], { recursive: true })
  }
  for (const [name, directory] of Object.entries(env)) {
    process.env[name] = directory
  }
  process.env[ROOT_ENV] = root

  // Bun caches os.homedir() before preloads run, unlike Node. Replace the
  // test-process accessor after HOME/USERPROFILE are contained so code using
  // node:os sees the same sandbox as code reading the environment directly.
  Object.defineProperty(os, "homedir", {
    configurable: true,
    enumerable: true,
    value: () => home,
    writable: true,
  })

  if (!isWithin(root, os.homedir())) {
    throw new Error(
      `Test user sandbox did not replace os.homedir(): ${os.homedir()}`,
    )
  }
  for (const name of DIRECTORY_ENV_NAMES) {
    const directory = env[name]
    if (!isWithin(root, directory)) {
      throw new Error(
        `Test user sandbox path escaped for ${name}: ${directory}`,
      )
    }
  }
  const windowsHome = path.resolve(`${env.HOMEDRIVE}${env.HOMEPATH}`)
  if (!isWithin(root, windowsHome)) {
    throw new Error(`Test Windows home escaped the sandbox: ${windowsHome}`)
  }

  return { root, env }
}

export function getTestUserSandbox(): TestUserSandbox {
  const root = process.env[ROOT_ENV]
  if (!root) throw new Error(`${ROOT_ENV} is not set; test preload did not run`)
  const env = Object.fromEntries(
    SANDBOX_ENV_NAMES.map((name) => {
      const value = process.env[name]
      if (!value) throw new Error(`${name} is not set by the test preload`)
      return [name, value]
    }),
  ) as Record<SandboxEnvName, string>
  return { root, env }
}

export function sandboxEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const { env } = getTestUserSandbox()
  return { ...process.env, ...env, ...overrides }
}
