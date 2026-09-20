/**
 * createTeeLogger is what makes auth events observable after the fact: it
 * writes through the GLOBAL consola (dev console + any consola spy) AND tees a
 * redacted copy to a dated `<name>-YYYY-MM-DD.log`. These tests pin both halves
 * — console delegation (so existing consola-spy tests keep working) and the
 * redacted file write (so a logged token can't leak to disk).
 */

import { afterEach, describe, expect, test } from "bun:test"
import consolaDefault from "consola"
import fs from "node:fs"
import path from "node:path"

import { createTeeLogger } from "~/lib/platform/logger"
import { PATHS } from "~/lib/platform/paths"
import { state } from "~/lib/runtime-state/state"

const consola = consolaDefault

function logFileFor(name: string): string {
  const dateKey = new Date().toLocaleDateString("sv-SE")
  return path.join(PATHS.APP_DIR, "logs", `${name}-${dateKey}.log`)
}

afterEach(() => {
  state.verbose = false
})

describe("createTeeLogger — console delegation", () => {
  test("warn/error/info forward to the global consola (so spies still fire)", () => {
    const calls: Array<Array<unknown>> = []
    const original = consola.warn.bind(consola)
    consola.warn = ((...args: Array<unknown>) => {
      calls.push(args)
    }) as typeof consola.warn
    try {
      const log = createTeeLogger("tee-console")
      log.warn("hello", "world")
      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual(["hello", "world"])
    } finally {
      consola.warn = original
    }
  })

  test("debug is suppressed unless verbose", () => {
    const calls: Array<Array<unknown>> = []
    const original = consola.debug.bind(consola)
    consola.debug = ((...args: Array<unknown>) => {
      calls.push(args)
    }) as typeof consola.debug
    try {
      const log = createTeeLogger("tee-debug")
      state.verbose = false
      log.debug("nope")
      expect(calls).toHaveLength(0)
      state.verbose = true
      log.debug("yep")
      expect(calls).toHaveLength(1)
    } finally {
      consola.debug = original
    }
  })
})

describe("createTeeLogger — redacted file write", () => {
  test("writes a dated file, keeps string labels, redacts object args", async () => {
    // Unique name so we own the file outright.
    const name = "tee-file-test"
    const file = logFileFor(name)
    if (fs.existsSync(file)) fs.unlinkSync(file)

    const log = createTeeLogger(name)
    log.warn("degraded for", "alice@github.com", {
      token: "ghu_supersecret_value_1234567890",
    })

    // The writer buffers and flushes on a 1s interval.
    await new Promise((r) => setTimeout(r, 1300))

    expect(fs.existsSync(file)).toBe(true)
    const body = fs.readFileSync(file, "utf8")
    // String labels survive; the line is tagged.
    expect(body).toContain("degraded for")
    expect(body).toContain("alice@github.com")
    expect(body).toContain("[warn]")
    expect(body).toContain(`[${name}]`)
    // The token inside the object arg is NEVER written raw.
    expect(body).not.toContain("ghu_supersecret_value_1234567890")

    fs.unlinkSync(file)
  })

  test("scrubs a secret passed as a bare STRING arg (the leak surface)", async () => {
    // Regression guard: createTeeLogger used to write string args verbatim, so
    // a token logged/interpolated as a string leaked to disk. It must be masked.
    const name = "tee-string-secret"
    const file = logFileFor(name)
    if (fs.existsSync(file)) fs.unlinkSync(file)

    const log = createTeeLogger(name)
    log.warn("GitHub token:", "ghu_AbCdEf0123456789AbCdEf0123456789")
    log.warn(
      "bearer tid=abc123def456ghi789;exp=1700000000;sku=z:deadbeefsignature",
    )

    await new Promise((r) => setTimeout(r, 1300))

    const body = fs.readFileSync(file, "utf8")
    expect(body).not.toContain("ghu_AbCdEf0123456789AbCdEf0123456789")
    expect(body).not.toContain("tid=abc123def456ghi789")
    expect(body).toContain("[redacted github token]")
    expect(body).toContain("[redacted copilot token]")

    fs.unlinkSync(file)
  })
})
