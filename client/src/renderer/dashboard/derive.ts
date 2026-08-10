import { type AgentRun, type Project, type RunStatus, type WorkspaceSnapshot } from '../workspace/model'
import { deriveStatusCounts, runsForProject } from '../workspace/source'

// Pure aggregation over a WorkspaceSnapshot for the dashboard/overview
// surface. Nothing here touches React or the DOM, so each function can be
// reasoned about (and, eventually, unit tested by whoever owns that) without
// a component tree. See stuffbucket/maximal#432 for the fleet model these
// derive from.

/**
 * Runs blocked on the person at the keyboard: the "waiting on you" queue.
 * Order is preserved from the snapshot — there is no priority field in
 * `AgentRun` (see model.ts) to sort by, so inventing an order here would
 * imply a signal the data doesn't carry.
 */
export function selectWaitingOnYou(snapshot: WorkspaceSnapshot): AgentRun[] {
  return snapshot.runs.filter((run) => run.status === 'needs-approval')
}

export interface ProjectRollup {
  project: Project
  counts: Record<RunStatus, number> & { all: number }
}

/**
 * Per-project status breakdown, in the same order as `snapshot.projects`.
 * Counts are derived from `snapshot.runs` filtered to the project's name via
 * `runsForProject` — never read from `project.runCount` directly — so a
 * rollup can't drift from the runs it's supposed to describe (the same
 * discipline `source.ts` uses to build `project.runCount` itself, and the
 * same helper `Workspace.tsx` uses for its projects-rail counts).
 */
export function deriveProjectRollups(snapshot: WorkspaceSnapshot): ProjectRollup[] {
  return snapshot.projects.map((project) => {
    const runs = runsForProject(snapshot.runs, project.name)
    return {
      project,
      counts: deriveStatusCounts({ projects: snapshot.projects, runs }),
    }
  })
}

export interface FinishedRuns {
  done: AgentRun[]
  failed: AgentRun[]
}

/**
 * Orders two finished runs most-recently-finished first. `finishedAt` is
 * optional on `AgentRun` (see model.ts) because an in-flight run genuinely
 * has none — but a `done`/`failed` run that somehow lacks one is treated as
 * having finished at the start of time (`-Infinity`) rather than "now": a
 * missing timestamp must sort to the *back* of "recently finished", never
 * masquerade as the most recent entry. Ties (including two runs both
 * missing a timestamp) fall back to `id` so the order is total and stable
 * instead of depending on `Array.prototype.sort`'s implementation-defined
 * behaviour on equal keys.
 */
function byMostRecentlyFinished(a: AgentRun, b: AgentRun): number {
  const aFinishedAt = a.finishedAt ?? -Infinity
  const bFinishedAt = b.finishedAt ?? -Infinity
  if (aFinishedAt !== bFinishedAt) return bFinishedAt - aFinishedAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Finished runs, split by outcome so "done" and "failed" are never merged
 * into one undifferentiated "finished" pile, and ordered most-recently-
 * finished first within each list.
 */
export function selectRecentlyFinished(snapshot: WorkspaceSnapshot): FinishedRuns {
  const done: AgentRun[] = []
  const failed: AgentRun[] = []
  for (const run of snapshot.runs) {
    if (run.status === 'done') done.push(run)
    else if (run.status === 'failed') failed.push(run)
  }
  return { done: done.sort(byMostRecentlyFinished), failed: failed.sort(byMostRecentlyFinished) }
}

export { deriveStatusCounts }
