/**
 * `maximal setup-status` CLI subcommand — JSON to stdout, exit 0 if
 * ready, exit 1 if not. See docs/first-run-setup-prd.md, "Open
 * Questions" #4.
 */

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("../", import.meta.url))
const tmpHome = path.join(os.tmpdir(), "maximal-setup-status-cli-test")
const decoder = new TextDecoder()

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

interface SetupStatusJson {
  ready: boolean
  nextStep: string | null
  checks: Record<string, { ok: boolean }>
}

function runSetupStatus(home: string): {
  exitCode: number
  stdout: string
  parsed: SetupStatusJson
} {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "run",
      "./src/main.ts",
      `--api-home=${home}`,
      "setup-status",
    ],
    cwd,
    env: {
      ...process.env,
      COPILOT_API_HOME: "",
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
    },
  })
  const stdout = decoder.decode(result.stdout)
  return {
    exitCode: result.exitCode,
    stdout,
    parsed: JSON.parse(stdout) as SetupStatusJson,
  }
}

describe("maximal setup-status", () => {
  test("exits 1 with JSON when github_token is missing", () => {
    // Fresh directory; no github_token written.
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.mkdirSync(tmpHome, { recursive: true })

    const { exitCode, parsed } = runSetupStatus(tmpHome)
    expect(exitCode).toBe(1)
    expect(parsed.ready).toBe(false)
    expect(parsed.nextStep).toBe("githubAuth")
  })

  test("exits 0 with ready=true when token + dirs present", () => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.mkdirSync(tmpHome, { recursive: true })
    fs.writeFileSync(
      path.join(tmpHome, "github_token"),
      JSON.stringify({
        schemaVersion: 1,
        tokenType: "ghu_",
        accessToken: "ghu_FAKE_TEST_TOKEN",
        refreshToken: null,
        obtainedAt: "2026-05-12T00:00:00.000Z",
      }),
    )

    const { exitCode, parsed } = runSetupStatus(tmpHome)
    expect(exitCode).toBe(0)
    expect(parsed.ready).toBe(true)
    expect(parsed.nextStep).toBeNull()
    expect(parsed.checks.githubAuth.ok).toBe(true)
  })
})
