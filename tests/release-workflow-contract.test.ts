import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

const readRepoFile = (path: string): Promise<string> =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8")

const readWorkflow = (name: string): Promise<string> =>
  readRepoFile(`.github/workflows/${name}`)

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

describe("release publication contract", () => {
  test("active release paths do not publish to npm", async () => {
    const files = await Promise.all([
      readWorkflow("release.yml"),
      readRepoFile("package.json"),
      readRepoFile("docs/commands.md"),
      readRepoFile("docs/release-runbook.md"),
    ])

    for (const file of files) {
      expect(file).not.toContain("npm publish")
      expect(file).not.toContain("bun publish")
      expect(file).not.toContain("npm_tag")
      expect(file).not.toContain("NPM_TAG")
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

describe("release action runtimes", () => {
  test("release actions use Node 24-compatible majors", async () => {
    const workflow = await readWorkflow("release.yml")

    expect(workflow).toContain("actions/cache@v5")
    expect(workflow).toContain("actions/upload-artifact@v5")
    expect(workflow).not.toContain("actions/cache@v4")
    expect(workflow).not.toContain("actions/upload-artifact@v4")
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

  test("the manifest job installs dependencies before generation and tests", async () => {
    const workflow = await readWorkflow("release.yml")
    const manifestJob = workflow.slice(workflow.indexOf("\n  manifest:"))
    const installIndex = manifestJob.indexOf("bun install --frozen-lockfile")
    const generationIndex = manifestJob.indexOf(
      "bun scripts/write-updates-manifest.ts",
    )
    const testIndex = manifestJob.indexOf("bun test")

    expect(installIndex).toBeGreaterThan(-1)
    expect(generationIndex).toBeGreaterThan(installIndex)
    expect(testIndex).toBeGreaterThan(installIndex)
  })
})
