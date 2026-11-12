// The bridge's data directory: COPILOT_API_HOME, then %APPDATA% (Windows), then XDG_DATA_HOME.
import { afterEach, describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"

import { dataDir, pairingTokenPath } from "../src/data-dir"

const ENV_KEYS = ["COPILOT_API_HOME", "APPDATA", "XDG_DATA_HOME"] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
const unset = (k: string) => Reflect.deleteProperty(process.env, k)

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k]
    if (v === undefined) unset(k)
    else process.env[k] = v
  }
})

describe("dataDir", () => {
  test("COPILOT_API_HOME wins", () => {
    process.env.COPILOT_API_HOME = "/h"
    process.env.XDG_DATA_HOME = "/x"
    process.env.APPDATA = "/a"
    expect(dataDir()).toBe("/h")
    expect(pairingTokenPath()).toBe(path.join("/h", "figjam", "pairing-token"))
  })

  test("falls back to XDG_DATA_HOME, then ~/.local/share", () => {
    for (const k of ENV_KEYS) unset(k)
    process.env.XDG_DATA_HOME = "/x"
    // %APPDATA% only counts on Windows.
    if (process.platform !== "win32")
      expect(dataDir()).toBe(path.join("/x", "maximal"))
    unset("XDG_DATA_HOME")
    unset("APPDATA")
    expect(dataDir()).toBe(
      path.join(os.homedir(), ".local", "share", "maximal"),
    )
  })
})
