import type { ReactElement } from 'react'

import { formatElapsed, type AgentRun } from '../workspace/model'
import type { FinishedRuns } from './derive'

// Recently finished, split into "Done" and "Failed" — two headed lists, not
// one merged pile with a status dot doing all the work. The group heading is
// the primary channel that separates success from failure; the row's own
// muted/danger tint is reinforcement, per the "status never color-alone"
// rule.
//
// Each list is ordered most-recently-finished first (see derive.ts's
// `selectRecentlyFinished`), and each row states *how* recent via
// `finishedAgo` below — otherwise the order would be a signal only the code
// knows about, invisible to whoever is reading the screen.

/**
 * "Xm YYs ago" for a row in this list. Built on `formatElapsed` (the same
 * duration formatter `RunCard`/`Inspector` use for `elapsedMs`) rather than a
 * second time-formatting routine — `shared/expiry.ts`'s `deriveExpiry` is
 * the wrong tool here: it counts down to a *future* ISO expiry, not up from
 * a *past* epoch-ms completion. `now` is injectable so tests don't depend on
 * the wall clock, the same pattern `deriveExpiry` uses for the same reason.
 */
function finishedAgo(finishedAt: number, now: number = Date.now()): string {
  return `Finished ${formatElapsed(Math.max(0, now - finishedAt))} ago`
}

interface RunGroupProps {
  heading: string
  runs: readonly AgentRun[]
  emptyText: string
  status: 'done' | 'failed'
}

function RunGroup({ heading, runs, emptyText, status }: RunGroupProps): ReactElement {
  return (
    <div>
      <h3 className="dashboard-finished__group-heading">
        {heading} ({runs.length})
      </h3>
      {runs.length === 0 ? (
        <p className="dashboard__empty-text">{emptyText}</p>
      ) : (
        <ul className="dashboard-rows" aria-label={heading}>
          {runs.map((run) => (
            <li className="dashboard-row dashboard-row--stacked" key={run.id}>
              <span className="dashboard-row__title" data-status={status}>
                {run.title}
              </span>
              <span className="dashboard-row__activity">
                {run.project} · {run.activity}
              </span>
              {run.finishedAt !== undefined ? (
                <span className="dashboard-row__meta">{finishedAgo(run.finishedAt)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface RecentlyFinishedProps {
  finished: FinishedRuns
}

export function RecentlyFinished({ finished }: RecentlyFinishedProps): ReactElement {
  return (
    <div className="dashboard-finished">
      <RunGroup heading="Done" runs={finished.done} emptyText="No completed runs yet." status="done" />
      <RunGroup heading="Failed" runs={finished.failed} emptyText="No failed runs." status="failed" />
    </div>
  )
}
