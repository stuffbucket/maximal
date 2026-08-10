import type { ComponentType, ReactElement } from 'react'

// The dashboard's left rail: in-page navigation to the three scrollable
// main-content sections (status totals, project rollups, recently
// finished). Deliberately not the `NavRail` component `../workspace/Workspace.tsx`
// uses twice — `NavRail` models a persistent single-select filter, and this
// rail doesn't filter anything; it jumps the scroll position. Reusing it
// here would promise a selection state the dashboard doesn't have. `current`
// instead reflects "the section you last jumped to," an honest, much
// smaller claim.
//
// Counts are the same real numbers the sections themselves render (fleet
// total, project count, finished count) — never a second, independently
// computed figure that could drift from the section it points at.

export interface SectionNavItem {
  id: string
  label: string
  count: number
  icon: ComponentType<{ size?: number }>
}

interface SectionNavProps {
  items: readonly SectionNavItem[]
  current: string | null
  onSelect: (id: string) => void
  collapsed: boolean
}

export function SectionNav({ items, current, onSelect, collapsed }: SectionNavProps): ReactElement {
  return (
    <nav className="dashboard-jump" aria-label="Dashboard sections">
      {!collapsed && <h2 className="dashboard-jump__heading">On this page</h2>}
      {items.map(({ id, label, count, icon: Icon }) => (
        <button
          key={id}
          type="button"
          className="dashboard-jump__link"
          aria-current={current === id}
          title={collapsed ? label : undefined}
          onClick={() => onSelect(id)}
          data-testid={`dashboard-jump-${id}`}
        >
          <Icon size={16} />
          {!collapsed && <span>{label}</span>}
          {!collapsed && <span className="dashboard-jump__count">{count}</span>}
        </button>
      ))}
    </nav>
  )
}
