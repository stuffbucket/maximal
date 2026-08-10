import type { ReactElement } from 'react'

import { statusLabel, type RunStatus } from '../workspace/model'

// Fleet-wide status totals. A row of real numbers, not a bar chart and not a
// grid of bordered tiles — docs/design/failure-modes.md's "page reads as a
// grid of similar rectangles" warning generalizes past the Tauri shell it's
// written for, and four same-sized boxes in a row is exactly that shape.
// Status is never color-alone here: the dot is `aria-hidden`, but the label
// under each figure is real text, and the status word ("Running",
// "Needs approval", ...) is the thing a screen reader (or a monochrome
// display) actually gets.

const STATUS_ORDER: readonly RunStatus[] = ['running', 'needs-approval', 'done', 'failed']

interface StatusTotalsProps {
  counts: Record<RunStatus, number> & { all: number }
}

export function StatusTotals({ counts }: StatusTotalsProps): ReactElement {
  return (
    <ul className="dashboard-totals" aria-label="Run status totals">
      <li className="dashboard-totals__item">
        <span className="dashboard-totals__figure">{counts.all}</span>
        <span className="dashboard-totals__label">All runs</span>
      </li>
      {STATUS_ORDER.map((status) => (
        <li className="dashboard-totals__item" data-status={status} key={status}>
          <span className="dashboard-totals__figure">
            <span className="dashboard-totals__dot" aria-hidden="true" />
            {counts[status]}
          </span>
          <span className="dashboard-totals__label">{statusLabel[status]}</span>
        </li>
      ))}
    </ul>
  )
}
