import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// The CLI puts the port into the 127.0.0.1 URL that carries the pairing
// token, so anything but a bare port number must stop it before a request.
const CLI = path.join(import.meta.dir, "..", "src", "cli.ts")
let home: string

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "figjam-cli-"))
})

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

function run(args: Array<string>, port?: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    COPILOT_API_HOME: home,
  }
  if (port === undefined) delete env.FIGJAM_BRIDGE_PORT
  else env.FIGJAM_BRIDGE_PORT = port
  const result = Bun.spawnSync([process.execPath, CLI, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: result.exitCode, stderr: result.stderr.toString() }
}

describe("bridge port", () => {
  for (const bad of [
    "1@evil.example",
    "4150/x",
    "0",
    "65536",
    "123456",
    "0x50",
    "",
  ]) {
    test(`refuses FIGJAM_BRIDGE_PORT=${JSON.stringify(bad)}`, () => {
      const { code, stderr } = run(["status"], bad)
      expect(code).toBe(2)
      expect(stderr).toContain(
        "The bridge port must be a number from 1 to 65535",
      )
    })
  }

  test("refuses a --port that isn't a number", () => {
    const { code, stderr } = run(["--port", "1@evil.example", "status"])
    expect(code).toBe(2)
    expect(stderr).toContain(JSON.stringify("1@evil.example"))
  })

  test("refuses a missing --port value", () => {
    expect(run(["--port"]).code).toBe(2)
  })

  test("accepts a port number and goes on to call the bridge", () => {
    // Nothing listens on the discard port, so the call itself fails.
    const { code, stderr } = run(["status"], "9")
    expect(code).toBe(1)
    expect(stderr).toContain("http://127.0.0.1:9")
  })
})
