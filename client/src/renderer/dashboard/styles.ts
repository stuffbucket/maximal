// Styles for the dashboard/overview surface.
//
// Injected once on import, guarded by element id — the same pattern
// RunCard.tsx and Inspector.tsx use in ../workspace, and for the same
// reason: there is no shared stylesheet file for this feature, so a single
// injected <style> beats duplicating rules per component. Values reference
// the `--shell-*` custom-property contract published by `stuffbucket-electron`
// (see RunCard.tsx's comment for the fallback-value rationale); this module
// ships no palette of its own.
//
// Deliberately no bordered "stat tile" grid here. `docs/design/failure-modes.md`
// (Tauri shell, but the underlying aesthetic call generalizes) flags a page
// that reads as a grid of similar rectangles as cards used for sectioning
// chrome — so totals, project rollups, and finished runs are rows in a
// list, separated by rules, not boxes in a grid.

export const DASHBOARD_CSS = `
.dashboard-banner {
  display: flex;
  align-items: baseline;
  gap: var(--shell-space-2, 8px);
  flex: none;
  padding: var(--shell-space-2, 8px) var(--shell-space-4, 16px);
  color: var(--shell-text, currentColor);
  background: var(--shell-accent-muted, transparent);
  border-bottom: 1px solid var(--shell-border, currentColor);
  border-left: 3px solid var(--shell-warning, currentColor);
  font-size: 0.9em;
}

.dashboard {
  display: flex;
  flex-direction: column;
  gap: var(--shell-space-5, 24px);
  padding: var(--shell-space-4, 16px);
  overflow-y: auto;
  height: 100%;
  box-sizing: border-box;
  color: var(--shell-text, #f5f5f5);
}

.dashboard__heading {
  margin: 0 0 var(--shell-space-1, 4px);
  font-size: 1.15em;
  font-weight: 600;
}

.dashboard__subhead {
  margin: 0;
  color: var(--shell-text-subtle, currentColor);
  font-size: 0.85em;
}

.dashboard__section {
  display: flex;
  flex-direction: column;
  gap: var(--shell-space-3, 12px);
  scroll-margin-top: var(--shell-space-4, 16px);
}

.dashboard__section-heading {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--shell-text-subtle, #6a6a6a);
}

.dashboard__empty-text {
  margin: 0;
  font-size: 13px;
  color: var(--shell-text-muted, #8a8a8a);
}

.dashboard-retry {
  align-self: flex-start;
}

/* ---- Status totals: a row of stat figures, not a grid of tiles ---- */
.dashboard-totals {
  display: flex;
  flex-wrap: wrap;
  gap: var(--shell-space-5, 24px);
  margin: 0;
  padding: 0;
  list-style: none;
}

.dashboard-totals__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 6ch;
}

.dashboard-totals__figure {
  display: flex;
  align-items: baseline;
  gap: var(--shell-space-1, 4px);
  font-size: 1.6em;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--shell-text, #f5f5f5);
}

.dashboard-totals__dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 9999px;
  background: currentcolor;
}

.dashboard-totals__item[data-status='running'] .dashboard-totals__figure { color: var(--shell-accent, #5198a6); }
.dashboard-totals__item[data-status='needs-approval'] .dashboard-totals__figure { color: var(--shell-warning, #eab308); }
.dashboard-totals__item[data-status='done'] .dashboard-totals__figure { color: var(--shell-success, #22c55e); }
.dashboard-totals__item[data-status='failed'] .dashboard-totals__figure { color: var(--shell-danger, #ef4444); }

.dashboard-totals__label {
  font-size: 12px;
  color: var(--shell-text-muted, #8a8a8a);
}

/* ---- Project rollups & recently-finished: list rows, not cards ---- */
.dashboard-rows {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--shell-border, #2a2a2a);
}

.dashboard-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--shell-space-3, 12px);
  padding: var(--shell-space-2, 8px) 0;
  border-bottom: 1px solid var(--shell-border, #2a2a2a);
}

.dashboard-row__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--shell-text, #f5f5f5);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dashboard-row__counts {
  display: flex;
  flex: none;
  gap: var(--shell-space-3, 12px);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--shell-text-muted, #8a8a8a);
  white-space: nowrap;
}

.dashboard-row__count[data-status='running'] { color: var(--shell-accent, #5198a6); }
.dashboard-row__count[data-status='needs-approval'] { color: var(--shell-warning, #eab308); }
.dashboard-row__count[data-status='done'] { color: var(--shell-success, #22c55e); }
.dashboard-row__count[data-status='failed'] { color: var(--shell-danger, #ef4444); }

.dashboard-row--stacked {
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

.dashboard-row__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--shell-text, #f5f5f5);
}

.dashboard-row__activity {
  font-size: 12px;
  color: var(--shell-text-muted, #8a8a8a);
}

.dashboard-row__title[data-status='failed'] {
  color: var(--shell-danger, #ef4444);
}

.dashboard-row__meta {
  font-size: 11px;
  color: var(--shell-text-subtle, #6a6a6a);
  font-variant-numeric: tabular-nums;
}

.dashboard-finished {
  display: flex;
  flex-direction: column;
  gap: var(--shell-space-4, 16px);
}

.dashboard-finished__group-heading {
  margin: 0 0 var(--shell-space-1, 4px);
  font-size: 12px;
  font-weight: 600;
  color: var(--shell-text-muted, #8a8a8a);
}

/* ---- Waiting-on-you: the right-rail queue ---- */
.dashboard-waiting {
  display: flex;
  flex-direction: column;
  gap: var(--shell-space-4, 16px);
  padding: var(--shell-space-4, 16px);
  color: var(--shell-text, #f5f5f5);
}

.dashboard-waiting__list {
  display: flex;
  flex-direction: column;
  gap: var(--shell-space-2, 8px);
  margin: 0;
  padding: 0;
  list-style: none;
}

.dashboard-waiting__item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--shell-space-2, 8px) var(--shell-space-3, 12px);
  border: 1px solid var(--shell-border, #2a2a2a);
  border-left: 3px solid var(--shell-warning, #eab308);
  border-radius: var(--shell-radius-small, 4px);
  background: var(--shell-canvas, transparent);
}

.dashboard-waiting__title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--shell-text, #f5f5f5);
}

.dashboard-waiting__meta {
  font-size: 11px;
  color: var(--shell-text-subtle, #6a6a6a);
}

.dashboard-waiting__blocked {
  font-size: 12px;
  color: var(--shell-text-muted, #8a8a8a);
}

/* ---- Left rail "on this page" nav (plain, honest — no filter it can't perform) ---- */
.dashboard-jump {
  display: flex;
  flex-direction: column;
  padding: var(--shell-space-3, 12px) var(--shell-space-2, 8px);
  gap: 2px;
}

.dashboard-jump__heading {
  margin: 0 0 var(--shell-space-1, 4px) var(--shell-space-2, 8px);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--shell-text-subtle, #6a6a6a);
}

.dashboard-jump__link {
  display: flex;
  align-items: center;
  gap: var(--shell-space-2, 8px);
  padding: var(--shell-space-2, 8px);
  border-radius: var(--shell-radius-small, 4px);
  color: var(--shell-text-muted, #8a8a8a);
  text-decoration: none;
  font-size: 13px;
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  font: inherit;
  transition: background-color 150ms ease-out, color 150ms ease-out;
}

.dashboard-jump__link:hover {
  background: var(--shell-hover, rgb(255 255 255 / 0.04));
  color: var(--shell-text, #f5f5f5);
}

.dashboard-jump__link[aria-current='true'] {
  color: var(--shell-accent, #5198a6);
  background: var(--shell-accent-muted, var(--shell-hover, rgb(255 255 255 / 0.04)));
}

.dashboard-jump__count {
  margin-left: auto;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--shell-text-subtle, #6a6a6a);
}

.dashboard-jump__link:focus-visible,
.dashboard-retry :focus-visible,
button.dashboard-retry:focus-visible {
  outline: 2px solid var(--shell-focus, var(--shell-accent, #5198a6));
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .dashboard-jump__link {
    transition-duration: 0.01ms;
  }
}
`

const DASHBOARD_STYLE_ID = 'dashboard-styles'

if (typeof document !== 'undefined' && !document.getElementById(DASHBOARD_STYLE_ID)) {
  const style = document.createElement('style')
  style.id = DASHBOARD_STYLE_ID
  style.textContent = DASHBOARD_CSS
  document.head.appendChild(style)
}
