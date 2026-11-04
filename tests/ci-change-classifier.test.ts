import { describe, expect, test } from "bun:test"

import {
  GENERATED_MANIFEST_BRANCH,
  GENERATED_RELEASE_BRANCH,
  affectsWindowsBroker,
  classifyCiChanges,
  diffSpecForEvent,
  hasSuccessfulCounterpart,
  isTrustedGeneratedTree,
} from "../scripts/ci-change-classifier"

const BASE = "1".repeat(40)
const HEAD = "2".repeat(40)

const pullRequestEvent = (branch = "feature/test") => ({
  pull_request: {
    base: { sha: BASE },
    head: {
      ref: branch,
      repo: { full_name: "stuffbucket/maximal" },
      sha: HEAD,
    },
    user: { login: "github-actions[bot]" },
  },
})

describe("diffSpecForEvent", () => {
  test("uses the PR payload even when GITHUB_SHA is its merge commit", () => {
    expect(
      diffSpecForEvent("pull_request", pullRequestEvent(), "3".repeat(40)),
    ).toEqual({
      base: BASE,
      head: HEAD,
      separator: "...",
    })
  })

  test("uses the complete pushed range", () => {
    expect(
      diffSpecForEvent("push", { after: HEAD, before: BASE }, HEAD),
    ).toEqual({ base: BASE, head: HEAD, separator: ".." })
  })

  test.each([
    ["workflow_dispatch", {}],
    ["schedule", {}],
    ["merge_group", { merge_group: { base_sha: BASE, head_sha: HEAD } }],
    ["push", { after: HEAD, before: "0".repeat(40) }],
    [
      "pull_request",
      { pull_request: { base: { sha: BASE }, head: { sha: "not-a-sha" } } },
    ],
  ])("fails closed for %s when no safe range exists", (eventName, event) => {
    expect(diffSpecForEvent(eventName, event, HEAD)).toBeUndefined()
  })
})

describe("Windows broker classification", () => {
  test.each([
    ["packages/mcp-broker/src/main.ts", true],
    ["packages/mcp-broker/pnpm-lock.yaml", true],
    ["src/lib/mcp-broker/supervisor.ts", true],
    ["src/routes/mcp/route.ts", true],
    ["tests/mcp-adapter-end-to-end.test.ts", true],
    [".github/workflows/ci.yml", true],
    ["package.json", true],
    ["docs/architecture.md", false],
    ["shell/src/main.ts", false],
    ["src/routes/messages/handler.ts", false],
  ])("classifies %s", (path, expected) => {
    expect(affectsWindowsBroker(path)).toBe(expected)
  })

  test("runs both Windows architectures for full, unknown, or empty validation", () => {
    for (const changed of ["all" as const, []]) {
      expect(classifyCiChanges(changed)).toEqual({
        mode: "full",
        windowsBroker: true,
      })
    }
  })

  test("skips Windows only when every known path is unrelated", () => {
    expect(
      classifyCiChanges(["docs/commands.md", "shell/src/main.ts"]),
    ).toEqual({
      mode: "paths",
      windowsBroker: false,
    })
    expect(
      classifyCiChanges([
        "docs/commands.md",
        "packages/mcp-broker/src/main.ts",
      ]),
    ).toEqual({ mode: "paths", windowsBroker: true })
  })
})

describe("successful counterpart detection", () => {
  const query = {
    branch: GENERATED_MANIFEST_BRANCH,
    eventName: "pull_request",
    headSha: HEAD,
    repository: "stuffbucket/maximal",
    runId: "200",
  }
  const run = {
    actor: { login: "github-actions[bot]" },
    conclusion: "success",
    event: "workflow_dispatch",
    head_branch: GENERATED_MANIFEST_BRANCH,
    head_repository: { full_name: "stuffbucket/maximal" },
    head_sha: HEAD,
    id: 100,
    name: "CI",
    path: ".github/workflows/ci.yml",
    repository: { full_name: "stuffbucket/maximal" },
    status: "completed",
  }

  test("accepts a successful opposite-event run for the exact trusted tree", () => {
    expect(hasSuccessfulCounterpart([{ workflow_runs: [run] }], query)).toBe(
      true,
    )
    expect(
      hasSuccessfulCounterpart(
        { workflow_runs: [{ ...run, event: "pull_request" }] },
        { ...query, eventName: "workflow_dispatch" },
      ),
    ).toBe(true)
  })

  test.each([
    ["actor", { actor: { login: "maintainer" } }],
    ["conclusion", { conclusion: "failure" }],
    ["event", { event: "pull_request" }],
    ["branch", { head_branch: GENERATED_RELEASE_BRANCH }],
    ["head SHA", { head_sha: BASE }],
    ["head repository", { head_repository: { full_name: "fork/maximal" } }],
    ["repository", { repository: { full_name: "fork/maximal" } }],
    ["workflow path", { path: ".github/workflows/other.yml" }],
    ["status", { status: "in_progress" }],
    ["current run", { id: 200 }],
  ])("rejects a run with the wrong %s", (_label, change) => {
    expect(
      hasSuccessfulCounterpart(
        { workflow_runs: [{ ...run, ...change }] },
        query,
      ),
    ).toBe(false)
  })

  test("fails closed on malformed API data or an unsupported current event", () => {
    expect(hasSuccessfulCounterpart({ nope: [] }, query)).toBe(false)
    expect(
      hasSuccessfulCounterpart(
        { workflow_runs: [run] },
        { ...query, eventName: "merge_group" },
      ),
    ).toBe(false)
  })
})

describe("CI workflow integration", () => {
  const workflow = Bun.file(
    new URL("../.github/workflows/ci.yml", import.meta.url),
  ).text()

  test("keeps the stable required check as a fail-closed aggregator", async () => {
    const source = await workflow
    expect(source).toContain("\n  test:\n    name: test\n    if: always()")
    expect(source).toContain(
      "needs: [classify, deduplicate, quality, unit-tests, broker, storybook]",
    )
    expect(source).toContain('if [ "$CLASSIFY" != "success" ]')
    expect(source).toContain('if [ "$DUPLICATE" = "true" ]')
    expect(source).toContain('expected="skipped"')
  })

  test("skips expensive jobs only for an explicit proven duplicate", async () => {
    const source = await workflow
    expect(
      source.match(/needs\.deduplicate\.outputs\.duplicate != 'true'/gu),
    ).toHaveLength(5)
    expect(source).toContain("needs.classify.outputs.windows_broker == 'true'")
    expect(source).toContain("runner: [windows-latest, windows-11-arm]")
  })

  test("grants Actions read only to trusted de-duplication and queries exact successful counterparts", async () => {
    const source = await workflow
    expect(source.match(/^ {6}actions: read$/gmu)).toHaveLength(1)
    expect(source).toContain(
      "deduplicate:\n    needs: classify\n    if: needs.classify.outputs.trusted_generated == 'true'",
    )
    expect(source).toContain("Find successful generated-PR counterpart")
    expect(source).toContain(
      "head_sha=$CI_HEAD_SHA&event=$counterpart&status=success",
    )
    expect(source).toContain("ci-change-classifier.ts --duplicate")
  })

  test("retains merge queue, exact dispatch, and commit-subject validation", async () => {
    const source = await workflow
    expect(source).toContain("merge_group:")
    expect(source).toContain("github.sha != inputs.expected_sha")
    expect(source).toContain("Check Conventional Commit subjects")
    expect(source).toContain("bun scripts/check-commit-msg.ts --subjects")
  })

  test("keys generated dispatch concurrency by the requested SHA", async () => {
    const source = await workflow
    const concurrency = source.slice(
      source.indexOf("concurrency:"),
      source.indexOf("\njobs:"),
    )

    expect(concurrency).toContain("&& inputs.expected_sha")
    expect(concurrency).not.toContain("|| github.sha")
  })

  test("installs broker dependencies before root unit tests", async () => {
    const source = await workflow
    const unitTests = source.slice(
      source.indexOf("\n  unit-tests:"),
      source.indexOf("\n  broker:"),
    )

    expect(unitTests).toContain("uses: ./.github/actions/setup-mise")
    expect(unitTests).toContain("mise -C packages/mcp-broker install")
    expect(unitTests).toContain(
      "mise -C packages/mcp-broker exec -- pnpm install --frozen-lockfile",
    )
    expect(
      unitTests.indexOf("Install isolated broker dependencies"),
    ).toBeLessThan(unitTests.indexOf("Run tests"))
  })
})

describe("trusted generated trees", () => {
  test("recognizes the bot-dispatched release tree", () => {
    expect(
      isTrustedGeneratedTree({
        actor: "github-actions[bot]",
        changed: [
          ".release-please-manifest.json",
          "CHANGELOG.md",
          "package.json",
        ],
        event: {},
        eventName: "workflow_dispatch",
        refName: GENERATED_RELEASE_BRANCH,
        repository: "stuffbucket/maximal",
      }),
    ).toBe(true)
  })

  test("recognizes a same-repository manifest PR tree", () => {
    expect(
      isTrustedGeneratedTree({
        actor: "github-actions[bot]",
        changed: [
          "site/public/updates/manifest.json",
          "site/public/updates/desktop/rc.json",
        ],
        event: pullRequestEvent(GENERATED_MANIFEST_BRANCH),
        eventName: "pull_request",
        refName: GENERATED_MANIFEST_BRANCH,
        repository: "stuffbucket/maximal",
      }),
    ).toBe(true)
  })

  test.each([
    {
      actor: "maintainer",
      changed: ["package.json"],
      event: {},
      eventName: "workflow_dispatch",
      refName: GENERATED_RELEASE_BRANCH,
    },
    {
      actor: "github-actions[bot]",
      changed: ["package.json", "src/main.ts"],
      event: {},
      eventName: "workflow_dispatch",
      refName: GENERATED_RELEASE_BRANCH,
    },
    {
      actor: "github-actions[bot]",
      changed: ["site/public/updates/desktop/rc.json"],
      event: pullRequestEvent(GENERATED_MANIFEST_BRANCH),
      eventName: "pull_request",
      refName: GENERATED_MANIFEST_BRANCH,
    },
    {
      actor: "maintainer",
      changed: ["site/public/updates/manifest.json"],
      event: {
        ...pullRequestEvent(GENERATED_MANIFEST_BRANCH),
        pull_request: {
          ...pullRequestEvent(GENERATED_MANIFEST_BRANCH).pull_request,
          user: { login: "maintainer" },
        },
      },
      eventName: "pull_request",
      refName: GENERATED_MANIFEST_BRANCH,
    },
    {
      actor: "github-actions[bot]",
      changed: "all" as const,
      event: {},
      eventName: "workflow_dispatch",
      refName: GENERATED_MANIFEST_BRANCH,
    },
  ])(
    "fails closed for an untrusted or unexpected generated tree",
    (scenario) => {
      expect(
        isTrustedGeneratedTree({
          ...scenario,
          repository: "stuffbucket/maximal",
        }),
      ).toBe(false)
    },
  )
})
