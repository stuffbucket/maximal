import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  parseWorkIqConfig,
  readWorkIqConfig,
  runWorkIq,
  WORKIQ_COMMAND_ARGS,
  type WorkIqRunner,
} from "~/lib/system/workiq-cli"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workiq-cli-"))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

/** A stand-in `workiq` that runs `body` as a POSIX shell script. */
function fakeWorkIq(name: string, body: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

const notFound: WorkIqRunner = () =>
  Promise.resolve({ stdout: "", stderr: "", code: 127, outcome: "not-found" })

describe("parseWorkIqConfig", () => {
  test("reads the EULA, the signed-in account and browser sign-in", () => {
    expect(
      parseWorkIqConfig(
        [
          "I-accept-EULA=true",
          "defaultAccount=someone@example.com",
          "disableBrokeredAuth=true",
          "Path: /Users/someone/.work-iq-cli/.workiq.json",
        ].join("\n"),
      ),
    ).toEqual({ eulaAccepted: true, signedInBefore: true, browserSignIn: true })
  })

  test("a fresh install has none of them", () => {
    expect(
      parseWorkIqConfig(
        "No config set.\nPath: /Users/someone/.work-iq-cli/.workiq.json\n",
      ),
    ).toEqual({
      eulaAccepted: false,
      signedInBefore: false,
      browserSignIn: false,
    })
  })

  test("tolerates spacing, case and Windows line ends; empty or false values don't count", () => {
    expect(
      parseWorkIqConfig(
        "  i-accept-eula = True\r\nDefaultAccount=\r\ndisableBrokeredAuth=false\r\n",
      ),
    ).toEqual({
      eulaAccepted: true,
      signedInBefore: false,
      browserSignIn: false,
    })
  })
})

describe("readWorkIqConfig", () => {
  test("runs `config show` and parses it", async () => {
    const calls: Array<Array<string>> = []
    const run: WorkIqRunner = (_executable, args) => {
      calls.push(args)
      return Promise.resolve({
        stdout: "I-accept-EULA=true\n",
        stderr: "",
        code: 0,
        outcome: "exited",
      })
    }
    expect(await readWorkIqConfig("/x/workiq", {}, run)).toEqual({
      installed: true,
      eulaAccepted: true,
      signedInBefore: false,
      browserSignIn: false,
    })
    expect(calls).toEqual([["config", "show"]])
  })

  test("reports not installed when the executable is gone", async () => {
    expect(await readWorkIqConfig("/gone/workiq", {}, notFound)).toEqual({
      installed: false,
      eulaAccepted: false,
      signedInBefore: false,
      browserSignIn: false,
    })
  })
})

describe("the commands Maximal runs", () => {
  test("are exactly these", () => {
    expect(WORKIQ_COMMAND_ARGS).toEqual({
      "config-show": ["config", "show"],
      "accept-eula": ["accept-eula"],
      "use-browser-sign-in": ["config", "set", "disableBrokeredAuth=true"],
      "sign-in": ["auth", "login"],
    })
  })
})

describe.skipIf(process.platform === "win32")("runWorkIq", () => {
  test("runs the command with its arguments and environment", async () => {
    const workiq = fakeWorkIq(
      "echo",
      'printf "%s|" "$@"; printf "%s" "$WORKIQ_TEST"; echo oops >&2',
    )
    const result = await runWorkIq(workiq, "config-show", {
      env: { WORKIQ_TEST: "seen" },
    })
    expect(result).toEqual({
      stdout: "config|show|seen",
      stderr: "oops\n",
      code: 0,
      outcome: "exited",
    })
  })

  test("reports a non-zero exit", async () => {
    const workiq = fakeWorkIq("fails", "exit 3")
    expect((await runWorkIq(workiq, "accept-eula")).code).toBe(3)
  })

  test("reports a missing executable", async () => {
    const result = await runWorkIq(path.join(dir, "missing"), "config-show")
    expect(result.outcome).toBe("not-found")
  })

  test("stops a command that runs too long", async () => {
    const workiq = fakeWorkIq("slow", "sleep 5")
    const result = await runWorkIq(workiq, "sign-in", { timeoutMs: 100 })
    expect(result.outcome).toBe("timed-out")
  })

  test("stops a command when cancelled", async () => {
    const workiq = fakeWorkIq("waits", "sleep 5")
    const controller = new AbortController()
    const running = runWorkIq(workiq, "sign-in", { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    expect((await running).outcome).toBe("cancelled")
  })
})
