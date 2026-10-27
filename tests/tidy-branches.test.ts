import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  type BranchRef,
  type TidyContext,
  decide,
  remoteRemovalCommand,
} from "../scripts/tidy-branches"

const scriptPath = fileURLToPath(
  new URL("../scripts/tidy-branches.ts", import.meta.url),
)

const DAY = 86_400
const NOW = 1_800_000_000

function ref(overrides: Partial<BranchRef> = {}): BranchRef {
  return {
    scope: "local",
    name: "feat/thing",
    sha: "abcdef0123456789abcdef0123456789abcdef01",
    committedAt: NOW - 30 * DAY,
    ...overrides,
  }
}

function ctx(overrides: Partial<TidyContext> = {}): TidyContext {
  return {
    now: NOW,
    idleDays: 14,
    inMain: new Set(),
    checkedOut: new Set(),
    openPrHeads: new Set(),
    mergedPrHeads: new Set(),
    keep: new Set(),
    ...overrides,
  }
}

describe("decide", () => {
  test.each([
    "main",
    "release/0.4.x",
    "release-please--branches--main",
    "dependabot/npm/x",
  ])("keeps protected %p even when idle and in main", (name) => {
    const branch = ref({ name })
    expect(decide(branch, ctx({ inMain: new Set([branch.sha]) })).action).toBe(
      "keep",
    )
  })

  test("a branch checked out in any worktree is never touched", () => {
    const branch = ref()
    const decision = decide(
      branch,
      ctx({
        checkedOut: new Set([branch.name]),
        inMain: new Set([branch.sha]),
      }),
    )
    expect(decision).toEqual({
      action: "keep",
      reason: "checked out in a worktree",
    })
  })

  test("a branch with an open PR is kept however old", () => {
    const branch = ref({ committedAt: NOW - 400 * DAY })
    expect(
      decide(branch, ctx({ openPrHeads: new Set([branch.name]) })).action,
    ).toBe("keep")
  })

  test("--keep wins over every removal rule", () => {
    const branch = ref()
    const decision = decide(
      branch,
      ctx({ keep: new Set([branch.name]), inMain: new Set([branch.sha]) }),
    )
    expect(decision.action).toBe("keep")
  })

  test("a tip already in main is deleted outright, even when fresh", () => {
    const branch = ref({ committedAt: NOW })
    expect(decide(branch, ctx({ inMain: new Set([branch.sha]) })).action).toBe(
      "delete",
    )
  })

  test("a fresh branch whose PR merged at this exact tip is archived", () => {
    const branch = ref({ committedAt: NOW })
    const decision = decide(
      branch,
      ctx({ mergedPrHeads: new Set([`${branch.name}@${branch.sha}`]) }),
    )
    expect(decision).toMatchObject({
      action: "archive",
      reason: "PR merged at this tip",
    })
  })

  test("a fresh branch with commits past its merged PR's head is kept", () => {
    const branch = ref({ committedAt: NOW })
    const decision = decide(
      branch,
      ctx({
        mergedPrHeads: new Set([
          `${branch.name}@0000000000000000000000000000000000000000`,
        ]),
      }),
    )
    expect(decision.action).toBe("keep")
  })

  test("idle work outside main is archived, recent work is kept", () => {
    expect(decide(ref({ committedAt: NOW - 14 * DAY }), ctx()).action).toBe(
      "archive",
    )
    expect(decide(ref({ committedAt: NOW - 13 * DAY }), ctx()).action).toBe(
      "keep",
    )
  })

  test("remote archives are pushed tags; local archives stay out of refs/tags", () => {
    const local = decide(ref(), ctx())
    const remote = decide(ref({ scope: "remote" }), ctx())
    expect(local).toMatchObject({
      archiveRef: "refs/archive/feat/thing/abcdef0",
    })
    expect(remote).toMatchObject({
      archiveRef: "refs/tags/archive/feat/thing/abcdef0",
    })
  })
})

describe("tidy-branches against real repositories", () => {
  let dir: string
  let work: string
  let origin: string
  let env: Record<string, string | undefined>

  function git(cwd: string, ...args: Array<string>): string {
    const result = Bun.spawnSync({
      cmd: ["git", ...args],
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0)
      throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
    return result.stdout.toString().trim()
  }

  function commit(cwd: string, message: string, ageDays = 0): string {
    const date = `${Math.floor(Date.now() / 1000) - ageDays * DAY} +0000`
    const prior = { a: env.GIT_AUTHOR_DATE, c: env.GIT_COMMITTER_DATE }
    env.GIT_AUTHOR_DATE = date
    env.GIT_COMMITTER_DATE = date
    git(cwd, "commit", "--allow-empty", "-q", "-m", message)
    env.GIT_AUTHOR_DATE = prior.a
    env.GIT_COMMITTER_DATE = prior.c
    return git(cwd, "rev-parse", "HEAD")
  }

  async function tidy(...args: Array<string>) {
    const proc = Bun.spawn(["bun", scriptPath, ...args], {
      cwd: work,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { exitCode, stdout, stderr }
  }

  function refs(cwd: string, pattern: string): Array<string> {
    const out = git(cwd, "for-each-ref", "--format=%(refname)", pattern)
    return out ? out.split("\n") : []
  }

  // Everything tidy could remove or create; fetch's own refs aside.
  function ownedRefs(): Array<string> {
    return [
      ...refs(work, "refs/heads"),
      ...refs(work, "refs/archive"),
      ...refs(work, "refs/tags"),
      ...refs(origin, "refs"),
    ]
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "maximal-tidy-branches-"))
    origin = join(dir, "origin.git")
    work = join(dir, "work")
    const fakeGh = join(dir, "gh")
    await writeFile(
      fakeGh,
      [
        "#!/bin/sh",
        'case "$*" in',
        `  *"--state open"*) printf '%s' '[{"headRefName":"reviewing","headRefOid":"x","isCrossRepository":false}]' ;;`,
        "  *) printf '[]' ;;",
        "esac",
        "",
      ].join("\n"),
    )
    await chmod(fakeGh, 0o755)
    env = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
      PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
    }

    git(dir, "init", "-q", "--bare", "-b", "main", origin)
    git(dir, "init", "-q", "-b", "main", work)
    git(work, "remote", "add", "origin", origin)
    commit(work, "chore: root", 90)
    git(work, "branch", "merged")
    commit(work, "feat: later", 60)
    git(work, "push", "-q", "origin", "main", "merged")

    for (const [name, ageDays] of [
      ["stale", 60],
      ["stale-remote", 60],
      ["fresh", 1],
      ["busy", 60],
      ["reviewing", 60],
    ] as const) {
      git(work, "switch", "-q", "-c", name, "main")
      commit(work, `feat: ${name}`, ageDays)
    }
    git(work, "push", "-q", "origin", "stale-remote")
    git(work, "switch", "-q", "--detach", "main")
    git(work, "worktree", "add", "-q", join(dir, "busy-tree"), "busy")
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("a dry run plans every rule and changes nothing", async () => {
    const before = ownedRefs()
    const { exitCode, stdout } = await tidy()

    expect(exitCode).toBe(0)
    expect(stdout).toContain("delete  merged (already in origin/main)")
    expect(stdout).toContain("delete  origin/merged (already in origin/main)")
    expect(stdout).toMatch(
      /archive stale \(idle 60d, not in main\) -> refs\/archive\/stale\/[0-9a-f]{7}/,
    )
    expect(stdout).toMatch(
      /archive origin\/stale-remote .* -> refs\/tags\/archive\/stale-remote\//,
    )
    expect(stdout).toContain("keep    fresh (active 1d ago)")
    expect(stdout).toContain("keep    busy (checked out in a worktree)")
    expect(stdout).toContain("keep    reviewing (open PR)")
    expect(stdout).toContain("Dry run.")
    expect(ownedRefs()).toEqual(before)
  })

  test("--apply archives before removing and never loses a tip", async () => {
    const staleSha = git(work, "rev-parse", "stale")
    const staleRemoteSha = git(work, "rev-parse", "stale-remote")
    const { exitCode, stderr } = await tidy("--apply")

    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    expect(refs(work, "refs/heads")).toEqual([
      "refs/heads/busy",
      "refs/heads/fresh",
      "refs/heads/main",
      "refs/heads/reviewing",
    ])
    expect(refs(origin, "refs/heads")).toEqual(["refs/heads/main"])

    // Local-only work stays local; remote work is archived on the remote.
    expect(
      git(work, "rev-parse", `refs/archive/stale/${staleSha.slice(0, 7)}`),
    ).toBe(staleSha)
    expect(refs(origin, "refs/archive")).toEqual([])
    expect(
      git(
        origin,
        "rev-parse",
        `refs/tags/archive/stale-remote/${staleRemoteSha.slice(0, 7)}`,
      ),
    ).toBe(staleRemoteSha)
    expect(refs(origin, "refs/tags")).toEqual([
      `refs/tags/archive/stale-remote/${staleRemoteSha.slice(0, 7)}`,
    ])
  })

  test("a remote branch pushed to after planning is neither archived nor deleted", () => {
    const planned = git(work, "rev-parse", "stale-remote")
    const other = join(dir, "other")
    git(dir, "clone", "-q", origin, other)
    git(other, "switch", "-q", "stale-remote")
    const moved = commit(other, "fix: still working", 60)
    git(other, "push", "-q", "origin", "stale-remote")

    const branch: BranchRef = {
      scope: "remote",
      name: "stale-remote",
      sha: planned,
      committedAt: 0,
    }
    const command = remoteRemovalCommand(branch, {
      action: "archive",
      reason: "idle",
      archiveRef: `refs/tags/archive/stale-remote/${planned.slice(0, 7)}`,
    })
    const push = Bun.spawnSync({ cmd: command, cwd: work, env, stderr: "pipe" })

    expect(push.exitCode).not.toBe(0)
    expect(git(origin, "rev-parse", "refs/heads/stale-remote")).toBe(moved)
    expect(refs(origin, "refs/tags")).toEqual([])
  })
})
