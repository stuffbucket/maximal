// Which bridge token the layout tools use: only an opted-in one, read from the bridge's data dir.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { bridgeToken } from "../src/token"

const ENV_KEYS = [
  "FIGJAM_TOKEN",
  "FIGJAM_USE_PAIRING_TOKEN",
  "COPILOT_API_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
const unset = (k: string) => Reflect.deleteProperty(process.env, k)

const home = mkdtempSync(join(tmpdir(), "figjam-layout-token-"))
const xdg = mkdtempSync(join(tmpdir(), "figjam-layout-xdg-"))

function writeToken(dir: string, value: string) {
  mkdirSync(join(dir, "figjam"), { recursive: true })
  writeFileSync(join(dir, "figjam", "pairing-token"), value)
}

beforeAll(() => {
  for (const k of ENV_KEYS) unset(k)
  process.env.COPILOT_API_HOME = home
})

afterEach(() => {
  for (const k of ENV_KEYS) unset(k)
  process.env.COPILOT_API_HOME = home
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(xdg, { recursive: true, force: true })
  for (const k of ENV_KEYS) {
    const v = savedEnv[k]
    if (v === undefined) unset(k)
    else process.env[k] = v
  }
})

describe("bridgeToken", () => {
  test("uses FIGJAM_TOKEN when it is set", () => {
    writeToken(home, "from-file\n")
    process.env.FIGJAM_TOKEN = "t0k"
    process.env.FIGJAM_USE_PAIRING_TOKEN = "1"
    expect(bridgeToken()).toBe("t0k")
  })

  test("is undefined without an opt-in, even when the token file exists", () => {
    writeToken(home, "from-file\n")
    expect(bridgeToken()).toBeUndefined()
  })

  test("reads the trimmed token file when opted in", () => {
    writeToken(home, "from-file\n")
    process.env.FIGJAM_USE_PAIRING_TOKEN = "1"
    expect(bridgeToken()).toBe("from-file")
  })

  test("is undefined when opted in but there is no token file", () => {
    process.env.COPILOT_API_HOME = join(home, "empty")
    process.env.FIGJAM_USE_PAIRING_TOKEN = "1"
    expect(bridgeToken()).toBeUndefined()
  })

  test("follows the bridge's data dir: XDG_DATA_HOME when COPILOT_API_HOME is unset", () => {
    writeToken(join(xdg, "maximal"), "from-xdg\n")
    unset("COPILOT_API_HOME")
    process.env.XDG_DATA_HOME = xdg
    process.env.FIGJAM_USE_PAIRING_TOKEN = "1"
    // On Windows the bridge prefers %APPDATA%; point that at the same place.
    process.env.APPDATA = xdg
    expect(bridgeToken()).toBe("from-xdg")
  })
})
