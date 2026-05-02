import { expect, test } from "bun:test"

import { getGitVersion, shortSha } from "../src/lib/version"

test("shortSha returns 'unknown' for undefined", () => {
  expect(shortSha(undefined)).toBe("unknown")
})

test("shortSha returns first 7 chars of a SHA", () => {
  expect(shortSha("b7dfda96014592820545f97fd69026894b1e4de2")).toBe("b7dfda9")
})

test("getGitVersion resolves the current branch + a 40-char sha when run in this repo", () => {
  const v = getGitVersion()
  // The dev tree always has .git; a SHA must be returned. Both
  // branch-resolved and detached-HEAD shapes are 40 hex chars.
  expect(v.sha).toMatch(/^[0-9a-f]{40}$/u)
  // Branch is undefined for detached HEAD; either is acceptable, but
  // when present must look like a ref name (no slashes-into-paths).
  if (v.branch !== undefined) {
    expect(typeof v.branch).toBe("string")
    expect(v.branch.length).toBeGreaterThan(0)
  }
})
