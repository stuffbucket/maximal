import { appendFileSync, readFileSync } from "node:fs"

export const GENERATED_RELEASE_BRANCH =
  "release-please--branches--main--components--maximal"
export const GENERATED_MANIFEST_BRANCH = "automation/updates-manifest"

const SHA = /^[0-9a-f]{40}$/u
const ZERO_SHA = /^0{40}$/u

const WINDOWS_BROKER_FILES = new Set([
  ".bun-version",
  ".github/workflows/ci.yml",
  "bun.lock",
  "mise.toml",
  "package.json",
  "scripts/ci-change-classifier.ts",
  "scripts/strip-lockfile-hosts.ts",
  "src/server.ts",
  "tests/mcp-adapter-end-to-end.test.ts",
])

const WINDOWS_BROKER_PREFIXES = [
  ".github/actions/setup-mise/",
  "packages/mcp-broker/",
  "src/lib/mcp-broker/",
  "src/routes/mcp/",
]

export type ChangedPaths = ReadonlyArray<string> | "all"

type JsonObject = Record<string, unknown>

export interface DiffSpec {
  base: string
  head: string
  separator: ".." | "..."
}

export interface CiClassification {
  mode: "full" | "paths"
  windowsBroker: boolean
}

export interface CounterpartQuery {
  branch: string
  eventName: string
  headSha: string
  repository: string
  runId: string
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function at(value: unknown, ...keys: Array<string>): unknown {
  let current = value
  for (const key of keys) {
    if (!isObject(current)) return undefined
    current = current[key]
  }
  return current
}

function stringAt(value: unknown, ...keys: Array<string>): string | undefined {
  const result = at(value, ...keys)
  return typeof result === "string" ? result : undefined
}

function validSha(value: string | undefined): value is string {
  return value !== undefined && SHA.test(value)
}

/**
 * Return a bounded diff only for events whose before/after contract is clear.
 * Dispatch, schedule, merge queue, malformed, and newly-created refs classify
 * as full rather than risking a false negative.
 */
export function diffSpecForEvent(
  eventName: string,
  event: unknown,
  githubSha: string,
): DiffSpec | undefined {
  if (eventName === "pull_request") {
    const base = stringAt(event, "pull_request", "base", "sha")
    const head = stringAt(event, "pull_request", "head", "sha")
    // pull_request workflows may expose the synthetic merge commit as
    // GITHUB_SHA; the payload's immutable head SHA is the diff endpoint.
    if (!validSha(base) || !validSha(head)) return undefined
    return { base, head, separator: "..." }
  }

  if (eventName === "push") {
    const base = stringAt(event, "before")
    const head = stringAt(event, "after")
    if (
      !validSha(base)
      || !validSha(head)
      || ZERO_SHA.test(base)
      || head !== githubSha
    )
      return undefined
    return { base, head, separator: ".." }
  }

  return undefined
}

export function affectsWindowsBroker(path: string): boolean {
  return (
    WINDOWS_BROKER_FILES.has(path)
    || WINDOWS_BROKER_PREFIXES.some((prefix) => path.startsWith(prefix))
  )
}

export function classifyCiChanges(changed: ChangedPaths): CiClassification {
  if (changed === "all" || changed.length === 0)
    return { mode: "full", windowsBroker: true }
  return {
    mode: "paths",
    windowsBroker: changed.some(affectsWindowsBroker),
  }
}

function counterpartEvent(eventName: string): string | undefined {
  if (eventName === "pull_request") return "workflow_dispatch"
  if (eventName === "workflow_dispatch") return "pull_request"
  return undefined
}

function workflowRuns(value: unknown): Array<unknown> {
  const pages = Array.isArray(value) ? value : [value]
  return pages.flatMap((page) => {
    const runs = at(page, "workflow_runs")
    return Array.isArray(runs) ? runs : []
  })
}

/**
 * Trust only a completed successful run of this workflow for the opposite
 * generated-PR event, on the same repository branch and exact head commit.
 */
export function hasSuccessfulCounterpart(
  value: unknown,
  query: CounterpartQuery,
): boolean {
  const expectedEvent = counterpartEvent(query.eventName)
  if (
    expectedEvent === undefined
    || !validSha(query.headSha)
    || (query.branch !== GENERATED_RELEASE_BRANCH
      && query.branch !== GENERATED_MANIFEST_BRANCH)
  )
    return false

  return workflowRuns(value).some((run) => {
    const id = at(run, "id")
    return (
      String(id ?? "") !== query.runId
      && stringAt(run, "name") === "CI"
      && stringAt(run, "path") === ".github/workflows/ci.yml"
      && stringAt(run, "event") === expectedEvent
      && stringAt(run, "status") === "completed"
      && stringAt(run, "conclusion") === "success"
      && stringAt(run, "head_branch") === query.branch
      && stringAt(run, "head_sha") === query.headSha
      && stringAt(run, "actor", "login") === "github-actions[bot]"
      && stringAt(run, "repository", "full_name") === query.repository
      && stringAt(run, "head_repository", "full_name") === query.repository
    )
  })
}

function generatedFilesMatch(
  branch: string,
  changed: ReadonlyArray<string>,
): boolean {
  if (changed.length === 0) return false
  if (branch === GENERATED_RELEASE_BRANCH) {
    const allowed = new Set([
      ".release-please-manifest.json",
      "CHANGELOG.md",
      "package.json",
    ])
    return changed.every((path) => allowed.has(path))
  }
  if (branch === GENERATED_MANIFEST_BRANCH) {
    return (
      changed.includes("site/public/updates/manifest.json")
      && changed.every((path) => path.startsWith("site/public/updates/"))
    )
  }
  return false
}

/** The generated-tree signal gates the workflow's de-duplication assumptions. */
export function isTrustedGeneratedTree(options: {
  actor: string
  changed: ChangedPaths
  event: unknown
  eventName: string
  refName: string
  repository: string
}): boolean {
  const { actor, changed, event, eventName, refName, repository } = options
  if (changed === "all" || !generatedFilesMatch(refName, changed)) return false

  if (eventName === "workflow_dispatch") {
    return actor === "github-actions[bot]"
  }

  if (eventName === "pull_request") {
    return (
      stringAt(event, "pull_request", "user", "login")
        === "github-actions[bot]"
      && stringAt(event, "pull_request", "head", "ref") === refName
      && stringAt(event, "pull_request", "head", "repo", "full_name")
        === repository
    )
  }

  return false
}

function gitChangedPaths(spec: DiffSpec): Array<string> | undefined {
  const result = Bun.spawnSync({
    cmd: [
      "git",
      "diff",
      "--name-only",
      "--no-renames",
      "--diff-filter=ACDMRTUXB",
      "-z",
      `${spec.base}${spec.separator}${spec.head}`,
    ],
    stdout: "pipe",
    stderr: "inherit",
  })
  if (result.exitCode !== 0) return undefined
  return new TextDecoder()
    .decode(result.stdout)
    .split("\0")
    .filter((path) => path !== "")
}

function writeOutput(name: string, value: string): void {
  const output = process.env.GITHUB_OUTPUT
  if (output) appendFileSync(output, `${name}=${value}\n`)
  else console.log(`${name}=${value}`)
}

if (import.meta.main) {
  if (process.argv.includes("--duplicate")) {
    let input: unknown
    try {
      input = JSON.parse(await new Response(Bun.stdin.stream()).text())
    }
    catch (error) {
      console.error(`Could not parse workflow runs; running full CI: ${String(error)}`)
    }
    const duplicate = hasSuccessfulCounterpart(input, {
      branch: process.env.CI_HEAD_BRANCH ?? "",
      eventName: process.env.GITHUB_EVENT_NAME ?? "",
      headSha: process.env.CI_HEAD_SHA ?? "",
      repository: process.env.GITHUB_REPOSITORY ?? "",
      runId: process.env.GITHUB_RUN_ID ?? "",
    })
    writeOutput("duplicate", String(duplicate))
  }
  else {
    const eventPath = process.env.GITHUB_EVENT_PATH
    const eventName = process.env.GITHUB_EVENT_NAME ?? ""
    const githubSha = process.env.GITHUB_SHA ?? ""
    const event: unknown = eventPath ?
      JSON.parse(readFileSync(eventPath, "utf8"))
    : {}
    const refName =
      eventName === "pull_request" ?
        (stringAt(event, "pull_request", "head", "ref")
          ?? process.env.GITHUB_REF_NAME
          ?? "")
      : (process.env.GITHUB_REF_NAME ?? "")
    const headSha =
      eventName === "pull_request" ?
        (stringAt(event, "pull_request", "head", "sha") ?? githubSha)
      : githubSha

    const diffSpec = diffSpecForEvent(eventName, event, githubSha)
    const changed = diffSpec ? (gitChangedPaths(diffSpec) ?? "all") : "all"
    const classification = classifyCiChanges(changed)

    // Dispatch remains full by policy. We inspect main...head only to recognize
    // the two bot-owned generated trees used by cross-event de-duplication.
    let generatedChanged: ChangedPaths = changed
    if (
      eventName === "workflow_dispatch"
      && (refName === GENERATED_RELEASE_BRANCH
        || refName === GENERATED_MANIFEST_BRANCH)
      && validSha(githubSha)
    ) {
      generatedChanged =
        gitChangedPaths({ base: "origin/main", head: githubSha, separator: "..." })
        ?? "all"
    }

    const trustedGenerated = isTrustedGeneratedTree({
      actor: process.env.GITHUB_ACTOR ?? "",
      changed: generatedChanged,
      event,
      eventName,
      refName,
      repository: process.env.GITHUB_REPOSITORY ?? "",
    })

    writeOutput("mode", classification.mode)
    writeOutput("windows_broker", String(classification.windowsBroker))
    writeOutput("trusted_generated", String(trustedGenerated))
    writeOutput("head_branch", refName)
    writeOutput("head_sha", headSha)
    writeOutput(
      "changed_count",
      changed === "all" ? "all" : String(changed.length),
    )
  }
}
