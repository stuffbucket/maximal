import type { ReactElement } from 'react'

import { type AgentRun, type RunStatus, statusLabel, formatElapsed } from './model'

// Presentational only — no data fetching, no source.ts import. See
// stuffbucket/maximal#432. Composed inside the shell's Canvas region
// (`@stuffbucket/maximal-electron/renderer`), which ships no palette and
// expects consumers to style against its `--shell-*` custom-property
// contract (see that package's README "Consume the shell frame" section
// and `scripts/shell-variables.mjs`). There is no shared stylesheet file
// for this feature yet (task scope is exactly two files), so the CSS
// below is injected once, on import, rather than duplicated inline per
// card instance.

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

const STATUS_TONE: Record<RunStatus, string> = {
  running: 'is-running',
  'needs-approval': 'is-needs-approval',
  done: 'is-done',
  failed: 'is-failed',
}

/** Status badge shared by RunCard and Inspector. Text always carries the
 *  status — color is reinforcement, never the only channel. */
export function StatusBadge({ status }: { status: RunStatus }): ReactElement {
  return (
    <span className={cx('status-badge', STATUS_TONE[status])}>
      <span className="status-badge__dot" aria-hidden="true" />
      {statusLabel[status]}
    </span>
  )
}

interface RunCardProps {
  run: AgentRun
  selected: boolean
  onSelect: (id: string) => void
}

// Cohesive presentational card; splitting fragments tightly-coupled JSX.
export function RunCard({ run, selected, onSelect }: RunCardProps): ReactElement {
  return (
    <button
      type="button"
      className={cx('run-card', selected && 'run-card--selected')}
      // The shell's `Canvas` hardcodes `role="listbox"` on the item container
      // (dist/renderer/components/Canvas.js), and a listbox's children must be
      // options carrying `aria-selected` — a button with `aria-current` inside
      // one is an invalid structure that assistive tech reports incoherently.
      // Kept as a real <button> so it stays keyboard-activatable, since `Canvas`
      // supplies no roving-tabindex model of its own. See maximal-electron#171.
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(run.id)}
    >
      <span className="run-card__head">
        <StatusBadge status={run.status} />
        <span className="run-card__elapsed">{formatElapsed(run.elapsedMs)}</span>
      </span>

      <span className="run-card__title">{run.title}</span>

      <span className="run-card__meta">
        <span className="run-card__project">{run.project}</span>
        {' · '}
        <span className="run-card__branch mono">{run.branch}</span>
      </span>

      <span className="run-card__activity">{run.activity}</span>

      <span className="run-card__footer">
        <span className="run-card__model mono">{run.model}</span>
        <span className="run-card__diff">
          <span className="run-card__diff-added">{`+${run.diff.added}`}</span>{' '}
          <span className="run-card__diff-removed">{`−${run.diff.removed}`}</span>
        </span>
      </span>
    </button>
  )
}

// ---- Styles ----
//
// Injected once on module import (guarded by element id so Vite HMR reloads
// don't pile up duplicate <style> tags). Classnames follow the BEM-ish
// convention already used by the Tauri shell's components (app-card,
// connection-card in shell/src/ui/styles/styles.css); values reference the
// `--shell-*` custom-property contract this package's host defines, with the
// same "sensible fallback" idiom `structural.css` itself uses
// (`var(--shell-warning, var(--shell-accent))`) for anything the contract
// doesn't publish (there's no `--shell-success` — diff-added and the "done"
// status fall back to maximal's existing status-success green so the two
// design systems agree if they're ever shown side by side).
const RUN_CARD_CSS = `
.run-card {
  display: flex;
  flex-direction: column;
  gap: var(--shell-space-2, 8px);
  width: 100%;
  box-sizing: border-box;
  padding: var(--shell-space-3, 12px) var(--shell-space-4, 16px);
  border: 1px solid var(--shell-border, #2a2a2a);
  border-radius: var(--shell-radius, 6px);
  background: var(--shell-canvas, transparent);
  color: var(--shell-text, #f5f5f5);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 150ms ease-out, border-color 150ms ease-out;
}

.run-card:hover {
  background: var(--shell-hover, rgb(255 255 255 / 0.04));
}

.run-card--selected {
  border-color: var(--shell-accent, #5198a6);
  background: var(--shell-accent-muted, var(--shell-hover, rgb(255 255 255 / 0.04)));
}

.run-card:focus-visible {
  outline: 2px solid var(--shell-focus, var(--shell-accent, #5198a6));
  outline-offset: 2px;
}

.run-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--shell-space-2, 8px);
}

.run-card__elapsed {
  font-size: 12px;
  color: var(--shell-text-subtle, #6a6a6a);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.run-card__title {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--shell-text, #f5f5f5);
}

.run-card__meta {
  font-size: 12px;
  color: var(--shell-text-muted, #8a8a8a);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-card__activity {
  font-size: 13px;
  color: var(--shell-text-muted, #8a8a8a);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--shell-space-2, 8px);
  margin-top: var(--shell-space-1, 4px);
}

.run-card__model {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: var(--shell-radius-small, 4px);
  background: var(--shell-hover, rgb(255 255 255 / 0.06));
  color: var(--shell-text-muted, #8a8a8a);
}

.run-card__diff {
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.run-card__diff-added {
  color: var(--shell-success, #22c55e);
}

.run-card__diff-removed {
  color: var(--shell-danger, #ef4444);
}

.mono {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}

/* ---- Status badge (shared with Inspector via the exported StatusBadge component) ---- */
.status-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--shell-space-1, 4px);
  padding: 2px var(--shell-space-2, 8px);
  border: 1px solid var(--shell-border, #2a2a2a);
  border-radius: var(--shell-radius-small, 4px);
  font-size: 12px;
  font-weight: 500;
  color: var(--shell-text-muted, #8a8a8a);
  white-space: nowrap;
}

.status-badge__dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 9999px;
  background: currentcolor;
}

.status-badge.is-running {
  color: var(--shell-accent, #5198a6);
}

.status-badge.is-needs-approval {
  color: var(--shell-warning, #eab308);
}

.status-badge.is-done {
  color: var(--shell-success, #22c55e);
}

.status-badge.is-failed {
  color: var(--shell-danger, #ef4444);
}

@media (prefers-reduced-motion: reduce) {
  .run-card {
    transition-duration: 0.01ms;
  }
}
`

const RUN_CARD_STYLE_ID = 'workspace-run-card-styles'

if (typeof document !== 'undefined' && !document.getElementById(RUN_CARD_STYLE_ID)) {
  const style = document.createElement('style')
  style.id = RUN_CARD_STYLE_ID
  style.textContent = RUN_CARD_CSS
  document.head.appendChild(style)
}
