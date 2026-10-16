/**
 * The one-time "Maximal is working" notice: arm on enable, announce on the
 * first tokens after, stay quiet after that, re-arm only when turned off.
 * Uses the preload's temp COPILOT_API_HOME, so notices.json is throwaway.
 */
import { beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { PATHS } from "~/lib/platform/paths"
import {
  armWorkingNotice,
  noteTokensFlowed,
  resetWorkingNotice,
  takeWorkingNotice,
} from "~/lib/working-notice"

const file = (): string => path.join(PATHS.APP_DIR, "notices.json")

beforeEach(() => {
  fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
  fs.rmSync(file(), { force: true })
  takeWorkingNotice()
})

describe("working notice", () => {
  test("announces an enabled app once, on the first tokens after", () => {
    armWorkingNotice("claude-code", "Claude Code")
    expect(takeWorkingNotice()).toBeNull()

    noteTokensFlowed()
    expect(takeWorkingNotice()).toEqual({ apps: ["Claude Code"] })
    expect(takeWorkingNotice()).toBeNull()

    noteTokensFlowed()
    expect(takeWorkingNotice()).toBeNull()
  })

  test("enabling an already-confirmed app again stays quiet", () => {
    armWorkingNotice("claude-code", "Claude Code")
    noteTokensFlowed()
    takeWorkingNotice()

    armWorkingNotice("claude-code", "Claude Code")
    noteTokensFlowed()
    expect(takeWorkingNotice()).toBeNull()
  })

  test("turning an integration off re-arms it for next time", () => {
    armWorkingNotice("claude-desktop", "Claude Desktop")
    noteTokensFlowed()
    takeWorkingNotice()

    resetWorkingNotice("claude-desktop")
    armWorkingNotice("claude-desktop", "Claude Desktop")
    noteTokensFlowed()
    expect(takeWorkingNotice()).toEqual({ apps: ["Claude Desktop"] })
  })

  test("a first-use notice names no app", () => {
    fs.writeFileSync(
      file(),
      JSON.stringify({ armed: [{ id: "first-use", name: "" }], confirmed: [] }),
    )
    noteTokensFlowed()
    expect(takeWorkingNotice()).toEqual({ apps: [] })
  })

  test("remembers across restarts (state is on disk)", () => {
    armWorkingNotice("claude-code", "Claude Code")
    noteTokensFlowed()
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse's type only accepts string
    const saved: unknown = JSON.parse(fs.readFileSync(file(), "utf8"))
    expect(saved).toEqual({ armed: [], confirmed: ["claude-code"] })
  })
})
