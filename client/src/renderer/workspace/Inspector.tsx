import type { ReactElement } from 'react'

import { StatusBadge } from './RunCard'
import { type AgentRun, formatElapsed } from './model'

// Presentational only — no data fetching. See stuffbucket/maximal#432.
// Composed inside the shell's collapsible right inspector
// (`@stuffbucket/maximal-electron/renderer`'s ShellLayout), which "shows
// properties when something is selected, and settings when nothing is" —
// this component is that split for a selected AgentRun. Styling follows the
// same `--shell-*` custom-property contract RunCard.tsx uses; see the
// comment above that file's injected stylesheet for the fallback-value
// rationale.

interface ToolCallRow {
  key: 'read' | 'edit' | 'bash'
  label: string
}

const TOOL_CALL_ROWS: readonly ToolCallRow[] = [
  { key: 'read', label: 'Read' },
  { key: 'edit', label: 'Edit' },
  { key: 'bash', label: 'Bash' },
]

interface DetailRow {
  label: string
  value: ReactElement | string
}

function buildDetailRows(run: AgentRun): DetailRow[] {
  return [
    { label: 'Project', value: run.project },
    { label: 'Branch', value: <span className="mono">{run.branch}</span> },
    { label: 'Model', value: <span className="mono">{run.model}</span> },
    { label: 'Elapsed', value: formatElapsed(run.elapsedMs) },
    { label: 'Tokens', value: run.tokens.toLocaleString() },
    {
      label: 'Diff',
      value: (
        <>
          <span className="inspector__diff-added">{`+${run.diff.added}`}</span>{' '}
          <span className="inspector__diff-removed">{`−${run.diff.removed}`}</span>
        </>
      ),
    },
  ]
}

interface InspectorProps {
  run: AgentRun | null
}

// Cohesive presentational panel; splitting fragments tightly-coupled JSX.
export function Inspector({ run }: InspectorProps): ReactElement {
  if (!run) {
    return (
      <aside className="inspector">
        <h2 className="inspector__eyebrow">Fleet</h2>
        <p className="inspector__empty-text">Select a run to inspect it.</p>
      </aside>
    )
  }

  const detailRows = buildDetailRows(run)
  const maxToolCalls = Math.max(run.toolCalls.read, run.toolCalls.edit, run.toolCalls.bash, 1)

  return (
    <aside className="inspector">
      <h2 className="inspector__eyebrow">Agent run</h2>
      <StatusBadge status={run.status} />
      <p className="inspector__title">{run.title}</p>
      <p className="inspector__activity">{run.activity}</p>

      <section className="inspector__section" aria-labelledby="inspector-details-heading">
        <h3 id="inspector-details-heading" className="inspector__eyebrow">
          Details
        </h3>
        <dl className="inspector__details">
          {detailRows.map((row) => (
            <div className="inspector__detail-row" key={row.label}>
              <dt className="inspector__detail-label">{row.label}</dt>
              <dd className="inspector__detail-value">{row.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="inspector__section" aria-labelledby="inspector-tool-calls-heading">
        <h3 id="inspector-tool-calls-heading" className="inspector__eyebrow">
          Tool calls
        </h3>
        <ul className="inspector__bars">
          {TOOL_CALL_ROWS.map(({ key, label }) => {
            const count = run.toolCalls[key]
            const pct = (count / maxToolCalls) * 100
            return (
              <li className="inspector__bar-row" key={key}>
                <span className="inspector__bar-label">{label}</span>
                <span className="inspector__bar-track" aria-hidden="true">
                  <span className="inspector__bar-fill" style={{ width: `${pct}%` }} />
                </span>
                {/* The count is a real text node, not just an aria-label: the
                    bar's width is decorative, never the only way the number
                    reaches a screen reader. */}
                <span className="inspector__bar-count">{count}</span>
              </li>
            )
          })}
        </ul>
      </section>
    </aside>
  )
}

// ---- Styles ----
//
// Injected once on import, guarded by element id (see RunCard.tsx for the
// same pattern and its rationale). `StatusBadge` is imported from
// RunCard.tsx rather than redefined here, so its `.status-badge` rules ship
// once — importing that module for the component runs its module-level
// style injection too, so `.status-badge` is guaranteed present before this
// stylesheet needs it.
const INSPECTOR_CSS = `
.inspector {
  display: flex;
  flex-direction: column;
  gap: var(--shell-space-4, 16px);
  padding: var(--shell-space-4, 16px);
  color: var(--shell-text, #f5f5f5);
}

.inspector__eyebrow {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--shell-text-subtle, #6a6a6a);
}

.inspector__empty-text {
  margin: 0;
  font-size: 13px;
  color: var(--shell-text-muted, #8a8a8a);
}

.inspector__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--shell-text, #f5f5f5);
}

.inspector__activity {
  margin: 0;
  font-size: 13px;
  color: var(--shell-text-muted, #8a8a8a);
}

.inspector__section {
  display: flex;
  flex-direction: column;
  gap: var(--shell-space-2, 8px);
}

.inspector__details {
  display: flex;
  flex-direction: column;
  gap: var(--shell-space-2, 8px);
  margin: 0;
}

.inspector__detail-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--shell-space-3, 12px);
}

.inspector__detail-label {
  margin: 0;
  font-size: 12px;
  color: var(--shell-text-subtle, #6a6a6a);
  flex: none;
}

.inspector__detail-value {
  margin: 0;
  font-size: 13px;
  color: var(--shell-text, #f5f5f5);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.inspector__diff-added {
  color: var(--shell-success, #22c55e);
  font-weight: 600;
}

.inspector__diff-removed {
  color: var(--shell-danger, #ef4444);
  font-weight: 600;
}

.inspector__bars {
  display: flex;
  flex-direction: column;
  gap: var(--shell-space-2, 8px);
  margin: 0;
  padding: 0;
  list-style: none;
}

.inspector__bar-row {
  display: grid;
  grid-template-columns: 44px 1fr auto;
  align-items: center;
  gap: var(--shell-space-2, 8px);
}

.inspector__bar-label {
  font-size: 12px;
  color: var(--shell-text-muted, #8a8a8a);
}

.inspector__bar-track {
  position: relative;
  height: 6px;
  border-radius: 9999px;
  background: var(--shell-hover, rgb(255 255 255 / 0.08));
  overflow: hidden;
}

.inspector__bar-fill {
  display: block;
  height: 100%;
  border-radius: 9999px;
  background: var(--shell-accent, #5198a6);
  transition: width 200ms ease-out;
}

.inspector__bar-count {
  min-width: 1.5em;
  font-size: 12px;
  text-align: right;
  color: var(--shell-text, #f5f5f5);
  font-variant-numeric: tabular-nums;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}

@media (prefers-reduced-motion: reduce) {
  .inspector__bar-fill {
    transition-duration: 0.01ms;
  }
}
`

const INSPECTOR_STYLE_ID = 'workspace-inspector-styles'

if (typeof document !== 'undefined' && !document.getElementById(INSPECTOR_STYLE_ID)) {
  const style = document.createElement('style')
  style.id = INSPECTOR_STYLE_ID
  style.textContent = INSPECTOR_CSS
  document.head.appendChild(style)
}
