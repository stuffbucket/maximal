import type { ReactElement } from 'react'

import { statusLabel, type RunStatus } from '../workspace/model'
import type { ProjectRollup } from './derive'

// Per-project rollups. Rows in one list, not a card per project — the same
// "no grid of similar rectangles" reasoning as StatusTotals. Each status
// count is real text (`"2 running"`), so the breakdown reads correctly with
// color turned off entirely.

const STATUS_ORDER: readonly RunStatus[] = ['running', 'needs-approval', 'done', 'failed']

interface ProjectRollupsProps {
  rollups: readonly ProjectRollup[]
}

export function ProjectRollups({ rollups }: ProjectRollupsProps): ReactElement {
  if (rollups.length === 0) {
    return <p className="dashboard__empty-text">No projects yet.</p>
  }

  return (
    <ul className="dashboard-rows" aria-label="Runs by project">
      {rollups.map(({ project, counts }) => {
        const nonZero = STATUS_ORDER.filter((status) => counts[status] > 0)
        return (
          <li className="dashboard-row" key={project.id}>
            <span className="dashboard-row__name">{project.name}</span>
            <span className="dashboard-row__counts">
              {nonZero.length === 0 ? (
                <span>No runs</span>
              ) : (
                nonZero.map((status) => (
                  <span className="dashboard-row__count" data-status={status} key={status}>
                    {counts[status]} {statusLabel[status].toLowerCase()}
                  </span>
                ))
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
