import { describe, expect, test } from "bun:test"

import {
  hasSuccessfulRequiredTest,
  trustedCiRuns,
  validateReleaseIdentity,
  versionFromReleaseTag,
  type ReleaseIdentity,
  type WorkflowJob,
  type WorkflowRun,
} from "../scripts/verify-release-source"

const SHA = "1".repeat(40)
const REPOSITORY = "stuffbucket/maximal"

const identity = (
  overrides: Partial<ReleaseIdentity> = {},
): ReleaseIdentity => ({
  eventName: "push",
  ref: "refs/tags/v1.2.3-rc.4",
  refName: "v1.2.3-rc.4",
  sha: SHA,
  tagTargetSha: SHA,
  packageVersion: "1.2.3-rc.4",
  manifestVersion: "1.2.3-rc.4",
  ...overrides,
})

const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 123,
  event: "push",
  head_branch: "main",
  head_repository: { full_name: REPOSITORY },
  head_sha: SHA,
  path: ".github/workflows/ci.yml",
  ...overrides,
})

const job = (overrides: Partial<WorkflowJob> = {}): WorkflowJob => ({
  conclusion: "success",
  name: "test",
  status: "completed",
  ...overrides,
})

describe("release identity", () => {
  test("accepts stable and prerelease tags and returns their exact version", () => {
    expect(versionFromReleaseTag("v1.2.3")).toBe("1.2.3")
    expect(versionFromReleaseTag("v1.2.3-rc.4")).toBe("1.2.3-rc.4")
    expect(() => versionFromReleaseTag("v1.2")).toThrow()
    expect(() => versionFromReleaseTag("v1.2.3-rc..4")).toThrow()
  })

  test("requires the tag ref, peeled commit and version files to agree", () => {
    expect(() => validateReleaseIdentity(identity())).not.toThrow()
    expect(() =>
      validateReleaseIdentity(identity({ tagTargetSha: "2".repeat(40) })),
    ).toThrow("resolves to")
    expect(() =>
      validateReleaseIdentity(identity({ packageVersion: "1.2.2" })),
    ).toThrow("package.json")
    expect(() =>
      validateReleaseIdentity(identity({ manifestVersion: "1.2.2" })),
    ).toThrow("release-please")
  })

  test("requires a manual dispatch input to match the selected tag", () => {
    expect(() =>
      validateReleaseIdentity(
        identity({ eventName: "workflow_dispatch", inputTag: "v1.2.3" }),
      ),
    ).toThrow("does not match")
    expect(() =>
      validateReleaseIdentity(
        identity({
          eventName: "workflow_dispatch",
          inputTag: "v1.2.3-rc.4",
        }),
      ),
    ).not.toThrow()
  })
})

describe("trusted exact-SHA CI workflow runs", () => {
  test("accepts main pushes and explicitly dispatched CI from this repository", () => {
    expect(trustedCiRuns([run()], SHA, REPOSITORY)).toHaveLength(1)
    expect(
      trustedCiRuns([run({ event: "workflow_dispatch" })], SHA, REPOSITORY),
    ).toHaveLength(1)
  })

  test.each([
    ["wrong SHA", { head_sha: "2".repeat(40) }],
    ["wrong workflow", { path: ".github/workflows/release.yml" }],
    ["fork", { head_repository: { full_name: "somebody/maximal" } }],
    ["untrusted event", { event: "pull_request" }],
    ["dev push", { head_branch: "dev" }],
  ])("rejects %s evidence", (_name, overrides) => {
    expect(trustedCiRuns([run(overrides)], SHA, REPOSITORY)).toEqual([])
  })

  test("allows workflow_dispatch recovery regardless of its selected tag branch name", () => {
    expect(
      trustedCiRuns(
        [run({ event: "workflow_dispatch", head_branch: "v1.2.3-rc.4" })],
        SHA,
        REPOSITORY,
      ),
    ).toHaveLength(1)
  })
})

describe("required CI test job", () => {
  test("accepts only a completed successful job named test", () => {
    expect(hasSuccessfulRequiredTest([job()])).toBe(true)
  })

  test.each([
    ["failed", { conclusion: "failure" }],
    ["in progress", { status: "in_progress", conclusion: null }],
    ["missing", null],
    ["wrong name", { name: "windows-broker (windows-latest)" }],
  ])("rejects %s required-check evidence", (_name, overrides) => {
    const jobs = overrides === null ? [] : [job(overrides)]
    expect(hasSuccessfulRequiredTest(jobs)).toBe(false)
  })
})
