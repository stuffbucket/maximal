import { describe, expect, test } from "bun:test"

import { subjectOf, subjectProblem } from "../scripts/check-commit-msg"

describe("check-commit-msg", () => {
  test.each([
    "feat: add a thing",
    "fix(codex): read config without a race",
    "build(deps-dev): bump astro from 6.4.8 to 7.3.3",
    "feat(api)!: drop the v0 endpoint",
    "chore(main): release 0.6.0",
    "Merge pull request #12 from stuffbucket/feat/x",
    "Merge remote-tracking branch 'origin/main' into feat/x",
    'Revert "feat: add a thing"',
    "fixup! fix: the earlier fix",
  ])("accepts %p", (subject) => {
    expect(subjectProblem(subject)).toBeUndefined()
  })

  test.each([
    "Add CNAME file for custom domain",
    "design(site): rebuild landing",
    "test+fix: both at once",
    "fix:missing space",
    "feat: ",
    "",
  ])("rejects %p", (subject) => {
    expect(subjectProblem(subject)).toContain("not a Conventional Commit")
  })

  test("reads the subject past blank and comment lines", () => {
    expect(subjectOf("\n# Please enter...\nfix: real subject\n\nbody\n")).toBe(
      "fix: real subject",
    )
  })
})
