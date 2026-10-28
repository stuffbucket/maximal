/**
 * Reading config.json as people save it: with a UTF-8 byte order mark
 * (Notepad, PowerShell 5's `Set-Content -Encoding utf8`), or broken. A file
 * Maximal can't read is never written over.
 */
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"

import {
  ConfigUnreadableError,
  getConfig,
  mergeConfigWithDefaults,
  reloadConfig,
  writeConfig,
} from "~/lib/config/config"
import { parseJsonText } from "~/lib/platform/json-text"
import { PATHS } from "~/lib/platform/paths"

/** A UTF-8 byte order mark, as the first character of a file. */
const BOM = String.fromCodePoint(0xfe_ff)

const original = getConfig()

afterEach(() => {
  // Put back a readable file first, so the guard lets the restore through.
  fs.writeFileSync(PATHS.CONFIG_PATH, "{}\n")
  reloadConfig()
  writeConfig(original)
})

describe("config.json with a byte order mark", () => {
  test("is read, not replaced by the defaults", () => {
    fs.writeFileSync(
      PATHS.CONFIG_PATH,
      `${BOM}${JSON.stringify({ smallModel: "bom-model", mcpBroker: { enabled: true } })}`,
    )
    const config = reloadConfig()
    expect(config.smallModel).toBe("bom-model")
    expect(config.mcpBroker?.enabled).toBe(true)
  })

  test("parseJsonText drops only a leading byte order mark", () => {
    expect(parseJsonText(`${BOM}{"a":1}`)).toEqual({ a: 1 })
    expect(parseJsonText(`{"a":"${BOM}"}`)).toEqual({ a: BOM })
  })
})

describe("a config.json that isn't valid JSON", () => {
  const broken = '{ "smallModel": "mine", '

  test("runs on the defaults and refuses to write over the file", () => {
    fs.writeFileSync(PATHS.CONFIG_PATH, broken)
    expect(reloadConfig().smallModel).not.toBe("mine")

    expect(() => writeConfig({ smallModel: "other" })).toThrow(
      ConfigUnreadableError,
    )
    mergeConfigWithDefaults()
    expect(fs.readFileSync(PATHS.CONFIG_PATH, "utf8")).toBe(broken)
  })

  test("can be written again once it reads", () => {
    fs.writeFileSync(PATHS.CONFIG_PATH, broken)
    reloadConfig()
    fs.writeFileSync(PATHS.CONFIG_PATH, '{ "smallModel": "fixed" }')
    expect(reloadConfig().smallModel).toBe("fixed")
    expect(writeConfig({ smallModel: "written" }).smallModel).toBe("written")
  })
})
