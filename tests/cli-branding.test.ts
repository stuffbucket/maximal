import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("../", import.meta.url))
const testOutputDir = path.join(cwd, ".test-output")
const testHome = path.join(testOutputDir, `cli-branding-${process.pid}`)
const decoder = new TextDecoder()

beforeAll(() => {
  fs.mkdirSync(testHome, { recursive: true })
})

afterAll(() => {
  fs.rmSync(testHome, { recursive: true, force: true })
  try {
    fs.rmdirSync(testOutputDir)
  } catch {
    // Another concurrently-running test may still own this directory.
  }
})

function runCli(args: Array<string>) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", "./src/main.ts", ...args],
    cwd,
    env: {
      HOME: process.env.HOME ?? cwd,
      PATH: process.env.PATH ?? "",
      TMPDIR: testHome,
      COPILOT_API_HOME: testHome,
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  return {
    exitCode: result.exitCode,
    output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
  }
}

describe("CLI branding", () => {
  test("debug output uses maximal command branding", () => {
    const result = runCli(["debug"])

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("maximal debug")
    expect(result.output).not.toContain("copilot-api debug")
  })

  test("setup output uses maximal command branding", () => {
    const result = runCli(["setup", "--unattended", "--skip-auth"])

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("maximal setup")
    expect(result.output).toContain("maximal debug")
    expect(result.output).not.toContain("copilot-api setup")
    expect(result.output).not.toContain("copilot-api debug")
  })
})
