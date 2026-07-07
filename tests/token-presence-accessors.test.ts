/**
 * Pin the token-trio single-owner accessors (#235). These lock the presence
 * semantics that the diagnostics / `/status` surfaces derive from, so a future
 * change to `hasGithubToken` / `hasCopilotToken` / `tokenPresence` / `clearTokenTrio`
 * can't silently flip what those wire payloads report.
 *
 * Behaviour-preserving contract: `hasX()` means `state.x !== undefined`, and the
 * accessors are the sole way production code reads/clears the trio. State is
 * seeded + torn down directly here (test fixtures, not production writers).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  clearTokenTrio,
  hasCopilotToken,
  hasGithubToken,
  modelsCached,
  setCopilotToken,
  setGithubToken,
  setUserName,
  state,
  tokenPresence,
} from "~/lib/state"
import { buildStatus } from "~/lib/status"

function clearAll(): void {
  clearTokenTrio()
  state.models = undefined
}

beforeEach(clearAll)
afterEach(clearAll)

describe("token-trio presence accessors", () => {
  test("hasGithubToken/hasCopilotToken match `!== undefined`", () => {
    expect(hasGithubToken()).toBe(false)
    expect(hasCopilotToken()).toBe(false)

    setGithubToken("ghu_x")
    expect(hasGithubToken()).toBe(true)
    expect(hasCopilotToken()).toBe(false)

    setCopilotToken("cop_y")
    expect(hasGithubToken()).toBe(true)
    expect(hasCopilotToken()).toBe(true)
  })

  test("tokenPresence() is a snapshot of the two flags", () => {
    expect(tokenPresence()).toEqual({ github: false, copilot: false })
    setGithubToken("ghu_x")
    expect(tokenPresence()).toEqual({ github: true, copilot: false })
    setCopilotToken("cop_y")
    expect(tokenPresence()).toEqual({ github: true, copilot: true })
  })

  test("setUserName writes the trio's identity field", () => {
    expect(state.userName).toBeUndefined()
    setUserName("octocat")
    expect(state.userName).toBe("octocat")
  })

  test("clearTokenTrio() clears all three by default", () => {
    setGithubToken("ghu_x")
    setCopilotToken("cop_y")
    setUserName("octocat")

    clearTokenTrio()

    expect(hasGithubToken()).toBe(false)
    expect(hasCopilotToken()).toBe(false)
    expect(state.userName).toBeUndefined()
  })

  test("clearTokenTrio({ userName }) clears only the selected field", () => {
    setGithubToken("ghu_x")
    setCopilotToken("cop_y")
    setUserName("octocat")

    clearTokenTrio({ userName: true })

    expect(hasGithubToken()).toBe(true)
    expect(hasCopilotToken()).toBe(true)
    expect(state.userName).toBeUndefined()
  })

  test("clearTokenTrio({ github, copilot }) leaves userName intact", () => {
    setGithubToken("ghu_x")
    setCopilotToken("cop_y")
    setUserName("octocat")

    clearTokenTrio({ github: true, copilot: true })

    expect(hasGithubToken()).toBe(false)
    expect(hasCopilotToken()).toBe(false)
    expect(state.userName).toBe("octocat")
  })

  test("modelsCached() counts the cached model catalog, 0 when empty", () => {
    expect(modelsCached()).toBe(0)
    state.models = {
      object: "list",
      data: [{ id: "a" }, { id: "b" }] as never,
    }
    expect(modelsCached()).toBe(2)
  })
})

describe("/status presence flags route through the accessors", () => {
  test("authenticated/ready/models mirror the trio + catalog", () => {
    const signedOut = buildStatus(Date.now())
    expect(signedOut.subsystems.copilot.authenticated).toBe(false)
    expect(signedOut.subsystems.copilot.ready).toBe(false)
    expect(signedOut.subsystems.models.cached).toBe(0)

    setGithubToken("ghu_x")
    const githubOnly = buildStatus(Date.now())
    expect(githubOnly.subsystems.copilot.authenticated).toBe(true)
    // ready requires BOTH github + copilot present
    expect(githubOnly.subsystems.copilot.ready).toBe(false)

    setCopilotToken("cop_y")
    state.models = { object: "list", data: [{ id: "a" }] as never }
    const ready = buildStatus(Date.now())
    expect(ready.subsystems.copilot.authenticated).toBe(true)
    expect(ready.subsystems.copilot.ready).toBe(true)
    expect(ready.subsystems.models.cached).toBe(1)
  })
})
