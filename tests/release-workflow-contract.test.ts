import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

const readWorkflow = (name: string): Promise<string> =>
  readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8")

describe("release workflow authentication", () => {
  test("active release workflows use no REPOMAN app token", async () => {
    const workflows = await Promise.all([
      readWorkflow("release-please.yml"),
      readWorkflow("release.yml"),
    ])

    for (const workflow of workflows) {
      expect(workflow).not.toContain("REPOMAN_APP_ID")
      expect(workflow).not.toContain("REPOMAN_APP_PRIVATE_KEY")
      expect(workflow).not.toContain("actions/create-github-app-token")
    }
  })
})

describe("generated pull request validation", () => {
  test("CI dispatches validate the exact requested SHA", async () => {
    const workflow = await readWorkflow("ci.yml")

    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain("expected_sha:")
    expect(workflow).toContain("github.sha != inputs.expected_sha")
  })

  test("release automation explicitly dispatches CI for generated PRs", async () => {
    const workflows = await Promise.all([
      readWorkflow("release-please.yml"),
      readWorkflow("release.yml"),
    ])

    for (const workflow of workflows) {
      expect(workflow).toContain("gh workflow run ci.yml")
      expect(workflow).toContain('-f expected_sha="$HEAD_SHA"')
    }
  })
})

describe("manifest publication", () => {
  test("the manifest job proposes a protected PR instead of pushing main", async () => {
    const workflow = await readWorkflow("release.yml")
    const manifestJob = workflow.slice(workflow.indexOf("\n  manifest:"))

    expect(manifestJob).toContain("pull-requests: write")
    expect(manifestJob).toContain("actions: write")
    expect(manifestJob).toContain("automation/updates-manifest")
    expect(manifestJob).toContain("gh pr create")
    expect(manifestJob).not.toContain("git push origin HEAD:main")
  })
})
