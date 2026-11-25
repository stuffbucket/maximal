/**
 * Keep `needs-triage` in step with the issue's labels (#657). An issue is
 * triaged when it has exactly one `playbook:*` label, plus exactly one
 * `repro:*` label when that playbook is `bug-fix` or `perf-issue`.
 * `needs-triage` is added while that is missing and removed once it holds.
 *
 * Issues repoman routes itself (`needs-bot`, `repoman:internal`) are left alone.
 * A milestone doesn't count as triaged here, unlike repoman's backstop.
 *
 *   bun scripts/triage-issue.ts <issue-number>   # needs GH_TOKEN and GH_REPO
 */

export const TRIAGE_LABEL = "needs-triage"
const ROUTED_ELSEWHERE = new Set(["needs-bot", "repoman:internal"])
const NEEDS_REPRO = new Set(["playbook:bug-fix", "playbook:perf-issue"])

export type TriageAction = "add" | "remove" | "none"

export function isTriaged(labels: ReadonlyArray<string>): boolean {
  const playbooks = labels.filter((label) => label.startsWith("playbook:"))
  if (playbooks.length !== 1) return false
  if (!NEEDS_REPRO.has(playbooks[0] ?? "")) return true
  return labels.filter((label) => label.startsWith("repro:")).length === 1
}

export function triageAction(labels: ReadonlyArray<string>): TriageAction {
  if (labels.some((label) => ROUTED_ELSEWHERE.has(label))) return "none"
  const flagged = labels.includes(TRIAGE_LABEL)
  const triaged = isTriaged(labels)
  if (triaged && flagged) return "remove"
  if (!triaged && !flagged) return "add"
  return "none"
}

function gh(args: Array<string>): string {
  const result = Bun.spawnSync(["gh", ...args])
  if (result.exitCode !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString()
}

if (import.meta.main) {
  const issue = process.argv[2] ?? ""
  if (!/^\d+$/.test(issue))
    throw new Error(`expected an issue number, got "${issue}"`)
  const labels = gh([
    "issue",
    "view",
    issue,
    "--json",
    "labels",
    "--jq",
    ".labels[].name",
  ])
    .split("\n")
    .filter((label) => label !== "")
  const action = triageAction(labels)
  if (action !== "none") {
    gh(["issue", "edit", issue, `--${action}-label`, TRIAGE_LABEL])
  }
  console.log(
    `#${issue}: ${action} ${TRIAGE_LABEL} (labels: ${labels.join(", ") || "none"})`,
  )
}
