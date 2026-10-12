import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptPath = fileURLToPath(
  new URL("../scripts/list-manifest-prs.ts", import.meta.url),
)

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "maximal-manifest-prs-"))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe("list-manifest-prs", () => {
  test("queries every pulls API page and normalizes the matching PRs", async () => {
    const argsPath = join(tempDir, "gh-args")
    const fakeGhPath = join(tempDir, "gh")
    await writeFile(
      fakeGhPath,
      [
        "#!/bin/sh",
        String.raw`printf '%s\n' "$@" > "$GH_ARGS_FILE"`,
        "printf '%s' \"$GH_RESPONSE\"",
        "",
      ].join("\n"),
    )
    await chmod(fakeGhPath, 0o755)

    const response = [
      [
        {
          number: 471,
          state: "open",
          html_url: "https://github.com/stuffbucket/maximal/pull/471",
          head: {
            ref: "automation/updates-manifest",
            sha: "1111111111111111111111111111111111111111",
          },
          base: { ref: "main" },
        },
      ],
      [
        {
          number: 472,
          state: "open",
          html_url: "https://github.com/stuffbucket/maximal/pull/472",
          head: {
            ref: "automation/updates-manifest",
            sha: "2222222222222222222222222222222222222222",
          },
          base: { ref: "main" },
        },
      ],
    ]

    const proc = Bun.spawn(["bun", scriptPath], {
      env: {
        ...process.env,
        GH_ARGS_FILE: argsPath,
        GH_RESPONSE: JSON.stringify(response),
        GITHUB_REPOSITORY: "stuffbucket/maximal",
        HEAD_BRANCH: "automation/updates-manifest",
        PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout)).toEqual([
      {
        number: 471,
        headRefName: "automation/updates-manifest",
        headRefOid: "1111111111111111111111111111111111111111",
        url: "https://github.com/stuffbucket/maximal/pull/471",
      },
      {
        number: 472,
        headRefName: "automation/updates-manifest",
        headRefOid: "2222222222222222222222222222222222222222",
        url: "https://github.com/stuffbucket/maximal/pull/472",
      },
    ])

    expect((await readFile(argsPath, "utf8")).trim().split("\n")).toEqual([
      "api",
      "--method",
      "GET",
      "--paginate",
      "--slurp",
      "repos/stuffbucket/maximal/pulls",
      "-f",
      "state=open",
      "-f",
      "base=main",
      "-f",
      "head=stuffbucket:automation/updates-manifest",
      "-f",
      "per_page=100",
    ])
  })
})
