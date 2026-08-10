import type { ReactElement } from 'react'

// The placeholder notice for the dashboard. Mirrors ../workspace/Workspace.tsx's
// `top`-slot banner rule for rule: persistent, non-dismissible, and rendered
// for the whole life of a placeholder source — a dashboard is exactly the
// surface where fake totals get mistaken for real ones, so this is at least
// as loud as the workspace's version, not quieter.
//
// `role="note"` puts it in the accessibility tree so it's announced on
// arrival; `id` lets the caller wire `aria-describedby` from the main region
// so the notice is read before the numbers it qualifies.

interface PlaceholderBannerProps {
  id: string
}

export function PlaceholderBanner({ id }: PlaceholderBannerProps): ReactElement {
  return (
    <div id={id} role="note" className="dashboard-banner" data-testid="dashboard-placeholder-notice">
      <strong>Placeholder data</strong>
      <span>
        Nothing on this dashboard is a real agent run. These totals, rollups, and queue entries are
        fixed sample values shown so the layout can be reviewed before live data exists.
      </span>
    </div>
  )
}
