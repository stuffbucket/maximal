import { readFile } from "node:fs/promises"

const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)$/u
const COMMIT_SHA = /^[0-9a-f]{40}$/u

export interface ReleaseIdentity {
  eventName: string
  ref: string
  refName: string
  inputTag?: string
  sha: string
  tagTargetSha: string
  packageVersion: string
  manifestVersion: string
}

export interface WorkflowRun {
  id: number
  event: string
  head_branch: string | null
  head_repository: { full_name: string } | null
  head_sha: string
  html_url?: string
  path: string
}

export interface WorkflowJob {
  conclusion: string | null
  name: string
  status: string
}

export function versionFromReleaseTag(tag: string): string {
  const match = RELEASE_TAG.exec(tag)
  if (!match)
    throw new Error(`Release tag must be vX.Y.Z[-prerelease], got '${tag}'.`)
  return match[1]
}

export function validateReleaseIdentity(identity: ReleaseIdentity): void {
  const version = versionFromReleaseTag(identity.refName)
  if (identity.ref !== `refs/tags/${identity.refName}`)
    throw new Error(
      `Release ref must be refs/tags/${identity.refName}, got '${identity.ref}'.`,
    )
  if (
    identity.eventName === "workflow_dispatch"
    && identity.inputTag !== identity.refName
  )
    throw new Error(
      `workflow_dispatch tag '${identity.inputTag ?? ""}' does not match selected ref '${identity.refName}'.`,
    )
  if (!COMMIT_SHA.test(identity.sha))
    throw new Error(`Release SHA is not a full commit SHA: '${identity.sha}'.`)
  if (identity.tagTargetSha !== identity.sha)
    throw new Error(
      `Tag ${identity.refName} resolves to ${identity.tagTargetSha}, not workflow SHA ${identity.sha}.`,
    )
  if (identity.packageVersion !== version)
    throw new Error(
      `package.json version '${identity.packageVersion}' does not match tag version '${version}'.`,
    )
  if (identity.manifestVersion !== version)
    throw new Error(
      `.release-please-manifest.json version '${identity.manifestVersion}' does not match tag version '${version}'.`,
    )
}

export function trustedCiRuns(
  runs: Array<WorkflowRun>,
  expectedSha: string,
  repository: string,
): Array<WorkflowRun> {
  return runs.filter(
    (run) =>
      run.head_sha === expectedSha
      && run.path === ".github/workflows/ci.yml"
      && run.head_repository?.full_name === repository
      && (run.event === "workflow_dispatch"
        || (run.event === "push" && run.head_branch === "main")),
  )
}

export function hasSuccessfulRequiredTest(jobs: Array<WorkflowJob>): boolean {
  return jobs.some(
    (job) =>
      job.name === "test"
      && job.status === "completed"
      && job.conclusion === "success",
  )
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function githubApi(path: string): unknown {
  const result = Bun.spawnSync({
    cmd: ["gh", "api", path],
    stdout: "pipe",
    stderr: "inherit",
  })
  if (result.exitCode !== 0)
    throw new Error(`GitHub Actions API exited ${result.exitCode}.`)
  return JSON.parse(result.stdout.toString()) as unknown
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Malformed GitHub Actions API ${context}.`)
  return value as Record<string, unknown>
}

function nullableString(value: unknown, context: string): string | null {
  if (value === null) return null
  if (typeof value !== "string")
    throw new Error(`Malformed GitHub Actions API ${context}.`)
  return value
}

function githubWorkflowRuns(
  repository: string,
  sha: string,
): Array<WorkflowRun> {
  const response = object(
    githubApi(
      `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`,
    ),
    "workflow-runs response",
  )
  if (!Array.isArray(response.workflow_runs))
    throw new Error("GitHub Actions API response has no workflow_runs array.")
  return response.workflow_runs.map((value, index) => {
    const run = object(value, `workflow run ${index}`)
    const repositoryValue =
      run.head_repository === null ?
        null
      : object(run.head_repository, "head repository")
    let headRepository: WorkflowRun["head_repository"] = null
    if (repositoryValue !== null) {
      if (typeof repositoryValue.full_name !== "string")
        throw new Error(`Malformed GitHub Actions API workflow run ${index}.`)
      headRepository = { full_name: repositoryValue.full_name }
    }
    if (
      typeof run.id !== "number"
      || !Number.isSafeInteger(run.id)
      || run.id <= 0
      || typeof run.event !== "string"
      || typeof run.head_sha !== "string"
      || typeof run.path !== "string"
      || (run.html_url !== undefined && typeof run.html_url !== "string")
    )
      throw new Error(`Malformed GitHub Actions API workflow run ${index}.`)
    return {
      id: run.id,
      event: run.event,
      head_branch: nullableString(run.head_branch, "head branch"),
      head_repository: headRepository,
      head_sha: run.head_sha,
      html_url: run.html_url,
      path: run.path,
    }
  })
}

function githubRunJobs(repository: string, runId: number): Array<WorkflowJob> {
  const response = object(
    githubApi(
      `repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
    ),
    "run-jobs response",
  )
  if (!Array.isArray(response.jobs))
    throw new Error("GitHub Actions API response has no jobs array.")
  return response.jobs.map((value, index) => {
    const job = object(value, `workflow job ${index}`)
    if (typeof job.name !== "string" || typeof job.status !== "string")
      throw new Error(`Malformed GitHub Actions API workflow job ${index}.`)
    return {
      conclusion: nullableString(job.conclusion, "job conclusion"),
      name: job.name,
      status: job.status,
    }
  })
}

async function main(): Promise<void> {
  const eventName = requiredEnvironment("GITHUB_EVENT_NAME")
  const ref = requiredEnvironment("GITHUB_REF")
  const refName = requiredEnvironment("GITHUB_REF_NAME")
  const sha = requiredEnvironment("GITHUB_SHA")
  const repository = requiredEnvironment("GITHUB_REPOSITORY")
  const tagTarget = Bun.spawnSync({
    cmd: ["git", "rev-parse", `${refName}^{commit}`],
    stdout: "pipe",
    stderr: "inherit",
  })
  if (tagTarget.exitCode !== 0)
    throw new Error(`Could not resolve ${refName} to a commit.`)

  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    version?: string
  }
  const releaseManifest = JSON.parse(
    await readFile(".release-please-manifest.json", "utf8"),
  ) as { "."?: unknown }
  const manifestVersion = releaseManifest["."]
  validateReleaseIdentity({
    eventName,
    ref,
    refName,
    inputTag: process.env.RELEASE_INPUT_TAG,
    sha,
    tagTargetSha: tagTarget.stdout.toString().trim(),
    packageVersion: packageJson.version ?? "",
    manifestVersion: typeof manifestVersion === "string" ? manifestVersion : "",
  })

  const waitSeconds = Number(process.env.CI_EVIDENCE_WAIT_SECONDS ?? "0")
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0)
    throw new Error("CI_EVIDENCE_WAIT_SECONDS must be a non-negative integer.")
  const deadline = Date.now() + waitSeconds * 1_000
  do {
    const runs = trustedCiRuns(
      githubWorkflowRuns(repository, sha),
      sha,
      repository,
    )
    for (const run of runs) {
      if (hasSuccessfulRequiredTest(githubRunJobs(repository, run.id))) {
        console.log(
          `Trusted exact-SHA required-check evidence: ${run.html_url ?? "successful ci.yml test job"}`,
        )
        return
      }
    }
    if (Date.now() >= deadline) break
    console.log(
      `No successful ci.yml test job for ${sha} yet; waiting 15 seconds.`,
    )
    await Bun.sleep(Math.min(15_000, Math.max(0, deadline - Date.now())))
  } while (Date.now() <= deadline)

  throw new Error(
    `No successful same-repository ci.yml test job validates exact release SHA ${sha}. `
      + `Dispatch ci.yml with --ref ${refName} -f expected_sha=${sha}, then re-run this release.`,
  )
}

if (import.meta.main) {
  await main()
}
