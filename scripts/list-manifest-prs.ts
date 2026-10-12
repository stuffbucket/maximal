import { z } from "zod"

const environmentSchema = z.object({
  GITHUB_REPOSITORY: z.string().regex(/^[^/]+\/[^/]+$/u),
  HEAD_BRANCH: z.string().min(1),
})

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.url(),
  head: z.object({
    ref: z.string(),
    sha: z.string().regex(/^[0-9a-f]{40}$/u),
  }),
})

const pagesSchema = z.array(z.array(pullRequestSchema))
const decoder = new TextDecoder()

const { GITHUB_REPOSITORY, HEAD_BRANCH } = environmentSchema.parse(process.env)
const [owner] = GITHUB_REPOSITORY.split("/")
const result = Bun.spawnSync({
  cmd: [
    "gh",
    "api",
    "--method",
    "GET",
    "--paginate",
    "--slurp",
    `repos/${GITHUB_REPOSITORY}/pulls`,
    "-f",
    "state=open",
    "-f",
    "base=main",
    "-f",
    `head=${owner}:${HEAD_BRANCH}`,
    "-f",
    "per_page=100",
  ],
  stdout: "pipe",
  stderr: "inherit",
})

if (result.exitCode !== 0) {
  process.exit(result.exitCode)
}

const pages = pagesSchema.parse(JSON.parse(decoder.decode(result.stdout)))
const pullRequests = pages.flatMap((page) =>
  page.map((pullRequest) => ({
    number: pullRequest.number,
    headRefName: pullRequest.head.ref,
    headRefOid: pullRequest.head.sha,
    url: pullRequest.html_url,
  })),
)

process.stdout.write(`${JSON.stringify(pullRequests)}\n`)
