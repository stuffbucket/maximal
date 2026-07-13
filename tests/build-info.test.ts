// build-info exposes compile-time constants injected via `bun build
// --compile --define`. Under `bun test` none of the `__MAXIMAL_*__`
// identifiers are defined, so every value must fall back to its source
// default without throwing (the `typeof` guards). This pins those fallbacks
// — in particular BUILD_CHANNEL, which decides the update channel a build
// polls and must default to "stable" for source/stock builds.

import { describe, expect, test } from "bun:test"

import {
  BUILD_CHANNEL,
  BUILD_GIT_BRANCH,
  BUILD_GIT_SHA,
  BUILD_VERSION,
} from "~/lib/update/build-info"

import packageJson from "../package.json" with { type: "json" }

describe("build-info fallbacks (no --define)", () => {
  test("BUILD_VERSION falls back to package.json version", () => {
    expect(BUILD_VERSION).toBe(packageJson.version)
  })

  test("BUILD_CHANNEL defaults to stable", () => {
    expect(BUILD_CHANNEL).toBe("stable")
  })

  test("git sha/branch are undefined without injection", () => {
    expect(BUILD_GIT_SHA).toBeUndefined()
    expect(BUILD_GIT_BRANCH).toBeUndefined()
  })
})
