/**
 * Tidy local and remote branches without losing work or pulling a branch out
 * from under a worktree.
 *
 *   bun run git:tidy                 # dry run: print the plan
 *   bun run git:tidy --apply         # carry it out
 *   bun run git:tidy --idle-days 30 --keep some/branch
 *
 * Every branch gets one decision, first matching rule wins:
 *   keep     protected name, checked out in any worktree, open PR, --keep,
 *            or committed to within --idle-days (default 14)
 *   delete   tip is already in origin/main (lossless: main holds the commits)
 *   archive  tip is a merged PR's head, or idle and not in main
 *
 * Archiving never loses a commit. A remote branch becomes the pushed tag
 * `archive/<branch>/<sha7>` in the same atomic push that deletes it. A local
 * branch becomes the local-only ref `refs/archive/<branch>/<sha7>`, which is
 * never pushed, so local-only work is not published by a cleanup. Restore with
 * `git branch <branch> <archive ref>`. Remote deletes are leased to the tip
 * that was planned, so a branch someone pushed to since is left alone.
 */

import { z } from "zod"

const BASE = "origin/main"
const PROTECTED = [
  /^(main|gh-pages)$/,
  /^release\//,
  /^release-please--/,
  /^dependabot\//,
]

export interface BranchRef {
  scope: "local" | "remote"
  name: string
  sha: string
  /** Committer date of the tip, unix seconds. */
  committedAt: number
}

export interface TidyContext {
  /** Unix seconds. */
  now: number
  idleDays: number
  inMain: ReadonlySet<string>
  checkedOut: ReadonlySet<string>
  openPrHeads: ReadonlySet<string>
  /** `${name}@${sha}` for each merged same-repo PR head. */
  mergedPrHeads: ReadonlySet<string>
  keep: ReadonlySet<string>
}

export type Decision =
  | { action: "keep"; reason: string }
  | { action: "delete"; reason: string }
  | { action: "archive"; reason: string; archiveRef: string }

export function archiveRefFor(ref: BranchRef): string {
  const short = ref.sha.slice(0, 7)
  return ref.scope === "remote" ?
      `refs/tags/archive/${ref.name}/${short}`
    : `refs/archive/${ref.name}/${short}`
}

export function decide(ref: BranchRef, ctx: TidyContext): Decision {
  if (PROTECTED.some((pattern) => pattern.test(ref.name)))
    return { action: "keep", reason: "protected name" }
  if (ctx.keep.has(ref.name)) return { action: "keep", reason: "--keep" }
  if (ctx.checkedOut.has(ref.name))
    return { action: "keep", reason: "checked out in a worktree" }
  if (ctx.openPrHeads.has(ref.name))
    return { action: "keep", reason: "open PR" }
  if (ctx.inMain.has(ref.sha))
    return { action: "delete", reason: `already in ${BASE}` }
  const archiveRef = archiveRefFor(ref)
  if (ctx.mergedPrHeads.has(`${ref.name}@${ref.sha}`))
    return { action: "archive", reason: "PR merged at this tip", archiveRef }
  const idle = Math.floor((ctx.now - ref.committedAt) / 86_400)
  if (idle >= ctx.idleDays)
    return {
      action: "archive",
      reason: `idle ${idle}d, not in main`,
      archiveRef,
    }
  return { action: "keep", reason: `active ${idle}d ago` }
}

function run(cmd: Array<string>): { ok: boolean; out: string; err: string } {
  const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" })
  return {
    ok: result.exitCode === 0,
    out: result.stdout.toString().trim(),
    err: result.stderr.toString().trim(),
  }
}

function must(cmd: Array<string>): string {
  const result = run(cmd)
  if (!result.ok) throw new Error(`${cmd.join(" ")}: ${result.err}`)
  return result.out
}

function lines(text: string): Array<string> {
  return text ? text.split("\n") : []
}

function listRefs(): Array<BranchRef> {
  const format = "%(refname)%09%(objectname)%09%(committerdate:unix)"
  return lines(
    must([
      "git",
      "for-each-ref",
      `--format=${format}`,
      "refs/heads",
      "refs/remotes/origin",
    ]),
  ).flatMap((line): Array<BranchRef> => {
    const [refname = "", sha = "", date = "0"] = line.split("\t")
    const local = refname.match(/^refs\/heads\/(.+)$/)
    const remote = refname.match(/^refs\/remotes\/origin\/(.+)$/)
    const committedAt = Number(date)
    if (local?.[1])
      return [{ scope: "local", name: local[1], sha, committedAt }]
    if (remote?.[1] && remote[1] !== "HEAD")
      return [{ scope: "remote", name: remote[1], sha, committedAt }]
    return []
  })
}

function checkedOutBranches(): Set<string> {
  return new Set(
    lines(must(["git", "worktree", "list", "--porcelain"])).flatMap((line) => {
      const branch = line.match(/^branch refs\/heads\/(.+)$/)?.[1]
      return branch ? [branch] : []
    }),
  )
}

const PullRequestHeads = z.array(
  z.object({
    headRefName: z.string(),
    headRefOid: z.string(),
    isCrossRepository: z.boolean(),
  }),
)

function pullRequestHeads(
  state: "open" | "merged",
): z.infer<typeof PullRequestHeads> {
  const out = must([
    "gh",
    "pr",
    "list",
    "--state",
    state,
    "--limit",
    "1000",
    "--json",
    "headRefName,headRefOid,isCrossRepository",
  ])
  return PullRequestHeads.parse(JSON.parse(out)).filter(
    (pr) => !pr.isCrossRepository,
  )
}

/** One atomic push: archive tag (if any) and a delete leased to the planned tip. */
export function remoteRemovalCommand(
  ref: BranchRef,
  decision: Exclude<Decision, { action: "keep" }>,
): Array<string> {
  const lease = `--force-with-lease=refs/heads/${ref.name}:${ref.sha}`
  const archive =
    decision.action === "archive" ? [`${ref.sha}:${decision.archiveRef}`] : []
  return [
    "git",
    "push",
    "--atomic",
    "--quiet",
    lease,
    "origin",
    ...archive,
    `:refs/heads/${ref.name}`,
  ]
}

function apply(ref: BranchRef, decision: Decision): string | undefined {
  if (decision.action === "keep") return undefined
  if (ref.scope === "remote") {
    const result = run(remoteRemovalCommand(ref, decision))
    return result.ok ? undefined : result.err
  }
  if (decision.action === "archive") {
    // Empty old value: create only, never move an existing archive ref.
    const created = run(["git", "update-ref", decision.archiveRef, ref.sha, ""])
    if (!created.ok) return created.err
  }
  const removed = run([
    "git",
    "update-ref",
    "-d",
    `refs/heads/${ref.name}`,
    ref.sha,
  ])
  if (!removed.ok) return removed.err
  run(["git", "config", "--remove-section", `branch.${ref.name}`])
  return undefined
}

function parseArgs(argv: Array<string>): {
  apply: boolean
  idleDays: number
  keep: Set<string>
} {
  const options = { apply: false, idleDays: 14, keep: new Set<string>() }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case "--apply": {
        options.apply = true
        break
      }
      case "--idle-days": {
        options.idleDays = Number(argv[++i])
        break
      }
      case "--keep": {
        options.keep.add(argv[++i] ?? "")
        break
      }
      default: {
        throw new Error(`unknown argument: ${arg}`)
      }
    }
  }
  if (!Number.isInteger(options.idleDays) || options.idleDays < 1)
    throw new Error("--idle-days must be a positive integer")
  return options
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2))
    must(["git", "fetch", "--prune", "--quiet", "origin"])
    const refs = listRefs()
    const ctx: TidyContext = {
      now: Math.floor(Date.now() / 1000),
      idleDays: options.idleDays,
      inMain: new Set(
        refs
          .filter(
            (ref) =>
              run(["git", "merge-base", "--is-ancestor", ref.sha, BASE]).ok,
          )
          .map((ref) => ref.sha),
      ),
      checkedOut: checkedOutBranches(),
      openPrHeads: new Set(
        pullRequestHeads("open").map((pr) => pr.headRefName),
      ),
      mergedPrHeads: new Set(
        pullRequestHeads("merged").map(
          (pr) => `${pr.headRefName}@${pr.headRefOid}`,
        ),
      ),
      keep: options.keep,
    }

    let failures = 0
    for (const ref of refs) {
      const decision = decide(ref, ctx)
      const label = `${ref.scope === "remote" ? "origin/" : ""}${ref.name}`
      const target =
        decision.action === "archive" ? ` -> ${decision.archiveRef}` : ""
      console.log(
        `${decision.action.padEnd(7)} ${label} (${decision.reason})${target}`,
      )
      if (!options.apply) continue
      const error = apply(ref, decision)
      if (error) {
        failures++
        console.error(`  failed: ${error}`)
      }
    }
    if (!options.apply)
      console.log("\nDry run. Re-run with --apply to carry out.")
    process.exit(failures ? 1 : 0)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
