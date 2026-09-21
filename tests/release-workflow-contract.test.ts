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

describe("release action supply chain", () => {
  test("external actions use current immutable releases", async () => {
    const workflow = await readWorkflow("release.yml")
    const externalUses = workflow.split("\n").flatMap((line) => {
      const marker = "uses: "
      const markerIndex = line.indexOf(marker)
      if (markerIndex === -1) return []

      const actionUse = line.slice(markerIndex + marker.length).trim()
      return actionUse.startsWith("./") ? [] : [actionUse]
    })
    const expectedUses = new Map([
      ["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1", 8],
      ["actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0", 1],
      [
        "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
        2,
      ],
    ])

    expect(externalUses).toHaveLength(11)
    for (const [expectedUse, count] of expectedUses) {
      expect(
        externalUses.filter((actionUse) => actionUse === expectedUse),
      ).toHaveLength(count)
    }
    for (const actionUse of externalUses) {
      expect(actionUse).toMatch(/^[^@\s]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/u)
    }
  })

  test("does not provision Node when the workflow does not invoke it", async () => {
    const workflow = await readWorkflow("release.yml")

    expect(workflow).not.toContain("actions/setup-node")
    expect(workflow).not.toContain("node-version:")
  })

  test("macOS signing is delegated to macos-builder", async () => {
    const workflow = await readWorkflow("release.yml")

    expect(workflow).toContain("--repo stuffbucket/macos-builder")
    expect(workflow).not.toContain("Codesign (macOS)")
    expect(workflow).not.toContain("Notarize (macOS)")
    expect(workflow).not.toContain("MACOS_DEVELOPER_ID")
    expect(workflow).not.toContain("AC_USERNAME")
    expect(workflow).not.toContain("AC_PASSWORD")
    expect(workflow).not.toContain("AC_TEAM_ID")
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
