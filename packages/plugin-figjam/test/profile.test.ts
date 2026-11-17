import { describe, expect, test } from "bun:test"

import {
  isVerbose,
  pluginProfileId,
  PRODUCTION_INSTANCE_ID,
  resolveProfile,
} from "../src/profile"

describe("resolveProfile", () => {
  test("no instance id is a local run", () => {
    expect(resolveProfile({})).toEqual({ kind: "local", id: "local" })
    expect(resolveProfile({ MAXIMAL_INSTANCE_ID: "  " })).toEqual({
      kind: "local",
      id: "local",
    })
  })

  test("the released app is production", () => {
    expect(
      resolveProfile({ MAXIMAL_INSTANCE_ID: PRODUCTION_INSTANCE_ID }),
    ).toEqual({ kind: "production", id: "production" })
  })

  test("an app:dev profile is identified by its worktree id", () => {
    expect(
      resolveProfile({
        MAXIMAL_INSTANCE_ID: "co.stuffbucket.maximal.dev.maximal-ab12cd34ef56",
      }),
    ).toEqual({ kind: "development", id: "ab12cd34ef56" })
  })

  test("any other identifier is a development profile with a stable derived id", () => {
    const first = resolveProfile({
      MAXIMAL_INSTANCE_ID: "co.stuffbucket.maximal.test.run-1",
    })
    expect(first.kind).toBe("development")
    expect(first.id).toMatch(/^[a-f0-9]{12}$/)
    expect(
      resolveProfile({
        MAXIMAL_INSTANCE_ID: "co.stuffbucket.maximal.test.run-1",
      }),
    ).toEqual(first)
    expect(
      resolveProfile({
        MAXIMAL_INSTANCE_ID: "co.stuffbucket.maximal.test.run-2",
      }).id,
    ).not.toBe(first.id)
  })
})

describe("profile helpers", () => {
  test("only development profiles name their Figma plugin", () => {
    expect(pluginProfileId({ kind: "development", id: "ab12cd34ef56" })).toBe(
      "ab12cd34ef56",
    )
    expect(pluginProfileId({ kind: "production", id: "production" })).toBe(
      undefined,
    )
    expect(pluginProfileId({ kind: "local", id: "local" })).toBe(undefined)
  })

  test("production is the one quiet profile", () => {
    expect(isVerbose({ kind: "production", id: "production" })).toBe(false)
    expect(isVerbose({ kind: "development", id: "x" })).toBe(true)
    expect(isVerbose({ kind: "local", id: "local" })).toBe(true)
  })
})
