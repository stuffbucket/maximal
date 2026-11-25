import { describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DiagnosticsResponse,
  UpdateStatusResponse,
} from "~/lib/config/settings-types"

import {
  DIAGNOSTICS,
  UPDATE_STATUS,
} from "../.claude/skills/ui-layout-verification/templates/fixture.diagnostics"

const repoRoot = join(import.meta.dir, "..")
const skillRoot = join(repoRoot, ".claude", "skills", "ui-layout-verification")

const readSkillFile = (path: string): Promise<string> =>
  Bun.file(join(skillRoot, path)).text()

describe("ui-layout-verification skill", () => {
  test("documents current diagnostics selectors", async () => {
    const skill = await readSkillFile("SKILL.md")
    const template = await readSkillFile("templates/island.spec.ts")
    expect(skill).toContain("--out /tmp/diag.png")
    expect(skill).toContain("--root '[data-section=\"diagnostics\"]'")
    expect(skill).toContain(
      "--ready '[data-diagnostics-root][aria-busy=\"false\"]'",
    )
    expect(skill).toContain(
      "--expect '[data-diagnostics-root],[data-uninstall-body],.uninstall-options'",
    )
    expect(template).toContain("const ROOT = '[data-section=\"diagnostics\"]'")
    expect(template).toContain('"[data-uninstall-body]"')
    expect(skill).not.toContain("postmortem-silent-layout-bugs.md")
    expect(
      await Bun.file(
        join(skillRoot, "references", "postmortem-silent-layout-bugs.md"),
      ).exists(),
    ).toBe(false)

    for (const content of [skill, template]) {
      expect(content).not.toContain("#diagnostics-root")
      expect(content).not.toContain(".uninstall-body")
      expect(content).not.toContain(".advanced-section")
    }
  })

  test("describes only the repository's current visual tooling", async () => {
    const reference = await readSkillFile("references/what-professionals-do.md")

    expect(reference).not.toContain("docs/dev/ui-visual-verification.md")
    expect(reference).not.toContain("Storybook + Chromatic")
    expect(reference).not.toContain("Typed CSS Modules for new island styles")
  })

  test("uses the repository's Playwright harness and config", async () => {
    const skill = await readSkillFile("SKILL.md")
    const template = await readSkillFile("templates/island.spec.ts")

    expect(skill).toContain("fixture.diagnostics.ts")
    expect(skill).toContain("tests/e2e/fixture.<section>.ts")
    expect(skill).not.toContain("tests/e2e/fixture.diagnostics.ts")
    expect(skill).toContain("bun run ui:harness -- --port 4747")
    expect(skill).toContain("bun run test:e2e -- tests/e2e/<section>.spec.ts")
    expect(skill).not.toContain("playwright.config.ts")
    expect(template).toContain("UI_HARNESS_URL")
    expect(template).toContain('[data-diagnostics-root][aria-busy="false"]')
    expect(template).toContain("await page.screenshot({")
    expect(template).toContain("overflow: visible !important")
    expect(template).not.toContain("toHaveScreenshot")
    expect(
      await Bun.file(
        join(skillRoot, "templates", "playwright.config.ts"),
      ).exists(),
    ).toBe(false)
  })
})

describe("ui-layout-verification fixture capture", () => {
  test("captures fixtures with a caller-provided API key", async () => {
    const script = await readSkillFile("scripts/capture-fixture.sh")

    expect(script).toContain("MAXIMAL_API_KEY")
    expect(script).toContain('"$BASE/status"')
    expect(script).toContain('\'"service":"maximal"\'')
    expect(script).toContain("--header @-")
    expect(script).not.toContain("--config -")
    expect(script).toContain(
      'import { readFileSync, writeFileSync } from "node:fs"',
    )
    expect(script).not.toContain('curl -sS -m 5 -H "x-api-key:')
    expect(script).not.toContain("require(")
    expect(script).not.toContain("sessionToken")
  })

  test("captures from an instance that does not require an API key", async () => {
    const fixture = { models: ["test-model"] }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url)
        if (pathname === "/status") {
          return Response.json({ service: "maximal" })
        }
        return pathname === "/settings/api/models" ?
            Response.json(fixture)
          : new Response("not found", { status: 404 })
      },
    })
    const output = join(tmpdir(), `maximal-fixture-${crypto.randomUUID()}.json`)

    try {
      const process = Bun.spawn(
        [
          "bash",
          join(skillRoot, "scripts", "capture-fixture.sh"),
          "--port",
          String(server.port),
          "--out",
          output,
        ],
        {
          env: { ...Bun.env, MAXIMAL_API_KEY: "" },
          stderr: "pipe",
          stdout: "pipe",
        },
      )
      const [exitCode, stderr] = await Promise.all([
        process.exited,
        new Response(process.stderr).text(),
      ])
      expect(exitCode, stderr).toBe(0)
      expect(await Bun.file(output).json()).toEqual(fixture)
    } finally {
      await server.stop(true)
      await rm(output, { force: true })
    }
  })

  test("passes legacy API keys without curl config parsing", async () => {
    const fixture = { models: ["test-model"] }
    const apiKey = String.raw`legacy"slash\key`
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url)
        if (pathname === "/status") {
          return Response.json({ service: "maximal" })
        }
        if (request.headers.get("x-api-key") !== apiKey) {
          return new Response("unauthorized", { status: 401 })
        }
        return pathname === "/settings/api/models" ?
            Response.json(fixture)
          : new Response("not found", { status: 404 })
      },
    })
    const output = join(tmpdir(), `maximal-fixture-${crypto.randomUUID()}.json`)

    try {
      const process = Bun.spawn(
        [
          "bash",
          join(skillRoot, "scripts", "capture-fixture.sh"),
          "--port",
          String(server.port),
          "--out",
          output,
        ],
        {
          env: { ...Bun.env, MAXIMAL_API_KEY: apiKey },
          stderr: "pipe",
          stdout: "pipe",
        },
      )
      const [exitCode, stderr] = await Promise.all([
        process.exited,
        new Response(process.stderr).text(),
      ])
      expect(exitCode, stderr).toBe(0)
      expect(await Bun.file(output).json()).toEqual(fixture)
    } finally {
      await server.stop(true)
      await rm(output, { force: true })
    }
  })
})

describe("ui-layout-verification preview safety", () => {
  test("rejects non-numeric preview ports", async () => {
    const process = Bun.spawn(
      [
        "bash",
        join(skillRoot, "scripts", "preview.sh"),
        "--stop",
        "4199/../../outside",
      ],
      { stderr: "pipe", stdout: "pipe" },
    )
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ])

    expect(exitCode).toBe(2)
    expect(stderr).toContain("unknown argument")
  })

  test("starts only when the launched preview owns the port", async () => {
    const script = await readSkillFile("scripts/preview.sh")

    expect(script).toContain("curl -sS --fail")
    expect(script).toContain('kill -0 "$PID"')
    expect(script).toContain('"service":"maximal"')
    expect(script).toContain('export HOME="$HOME_DIR"')
    expect(script).toContain('LOGFILE="${STATE_DIR}/preview.log"')
    expect(script).toContain('if ! mkdir "$STATE_DIR"')
    expect(script).toContain('LAUNCHERFILE="${STATE_DIR}/launcher"')
    expect(script).toContain('IDENTITYFILE="${STATE_DIR}/identity"')
    expect(script).toContain('ps -p "$PID" -o lstart=')
    expect(script).toContain("preview startup is still in progress")
    expect(script).toContain(String.raw`printf '%s\n' "$$" >"$LAUNCHERFILE"`)
    expect(script.indexOf('if ! mkdir "$STATE_DIR"')).toBeLessThan(
      script.indexOf("port ${port} is unavailable"),
    )
    expect(script).toContain("exec nohup bun run ./src/main.ts")
    expect(script).toContain("preview state retained at")
    const failureMessage = script.indexOf("preview failed to start")
    expect(script.slice(failureMessage - 100, failureMessage)).not.toContain(
      "cleanup_state",
    )
  })

  test("refuses a matching command without the recorded process identity", async () => {
    const port = 45_000 + Math.floor(Math.random() * 10_000)
    const state = `/tmp/maximal-preview-${port}`
    const process = Bun.spawn(
      [
        "bash",
        "-c",
        "trap '' TERM; while :; do sleep 1; done",
        `src/main.ts start --port ${port}`,
      ],
      { stderr: "ignore", stdout: "ignore" },
    )

    try {
      await mkdir(state, { mode: 0o700 })
      await writeFile(join(state, "pid"), `${process.pid}\n`)
      const stop = Bun.spawn(
        ["bash", join(skillRoot, "scripts", "preview.sh"), "--stop", `${port}`],
        { stderr: "pipe", stdout: "pipe" },
      )
      const [exitCode, stderr] = await Promise.all([
        stop.exited,
        new Response(stop.stderr).text(),
      ])

      expect(exitCode).toBe(1)
      expect(stderr).toContain("refusing to stop")
      expect(await Bun.spawn(["kill", "-0", `${process.pid}`]).exited).toBe(0)
    } finally {
      process.kill(9)
      await process.exited
      await rm(state, { force: true, recursive: true })
    }
  })

  test("never kills a listener when preview state is missing", async () => {
    const script = await readSkillFile("scripts/preview.sh")

    expect(script).not.toContain('lsof -ti "tcp:${PORT}"')
    expect(script).toContain("leaving the port untouched")
    expect(script).toContain("preview did not stop; state retained")
  })
})

describe("ui-layout-verification inspection", () => {
  test("checks hooks inside the selected root", async () => {
    const script = await readSkillFile("scripts/inspect.ts")

    expect(script).toContain("root.querySelectorAll(expectedSelector)")
    expect(script).not.toContain("document.querySelectorAll(expectedSelector)")
  })

  test("reports malformed expected selectors", async () => {
    const script = await readSkillFile("scripts/inspect.ts")

    expect(script).toContain('from "@playwright/test"')
    expect(script).toContain('waitUntil: "domcontentloaded"')
    expect(script).toContain(
      'const readySelector = flag("--ready", rootSelector)',
    )
    expect(script).toContain(
      'page.locator(readySelector).waitFor({ state: "visible" })',
    )
    expect(script).toContain("document.fonts.ready")
    expect(script).not.toContain("waitForTimeout")
    expect(script).not.toContain('waitUntil: "networkidle"')
    expect(script).toContain("child.getClientRects().length > 0")
    expect(script).toContain('"inline-flex"')
    expect(script).toContain('"inline-grid"')
    expect(script).toContain("columnGap")
    expect(script).toContain("current.left - previous.right")
    expect(script).toContain("overflow: visible !important")
    expect(script).toContain("invalidSelectors")
    expect(script).toContain("INVALID EXPECTED SELECTORS")
  })

  test("does not duplicate the repository UI harness", async () => {
    expect(
      await Bun.file(
        join(skillRoot, "scripts", "preview-fixtures.ts"),
      ).exists(),
    ).toBe(false)
  })

  test("type-checks skill scripts in the standard gate", async () => {
    const packageJson = await Bun.file(join(repoRoot, "package.json")).text()

    expect(packageJson).toContain(
      "tsc -p .claude/skills/ui-layout-verification/tsconfig.json",
    )
  })

  test("keeps template fixtures aligned with response schemas", () => {
    expect(DiagnosticsResponse.parse(DIAGNOSTICS)).toEqual(DIAGNOSTICS)
    expect(UpdateStatusResponse.parse(UPDATE_STATUS)).toEqual(UPDATE_STATUS)
    expect(UPDATE_STATUS.checked_at).toBeNull()
  })
})
