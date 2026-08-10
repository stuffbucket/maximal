import { useCallback, useEffect, useId, useMemo, useState, type CSSProperties } from 'react'
import {
  Canvas,
  getTabPanelId,
  getTabTriggerId,
  IconButton,
  NavRail,
  ShellLayout,
  type CanvasViewMode,
  type NavRailEntry,
  type NavRailSection,
  type Tab,
} from 'stuffbucket-electron/renderer'
import 'stuffbucket-electron/renderer/styles.css'

import { Inspector } from './Inspector'
import { RunCard } from './RunCard'
import { statusLabel, type AgentRun, type RunStatus, type WorkspaceSnapshot } from './model'
import { deriveStatusCounts, runsForProject, type WorkspaceSource } from './source'

/*
 * The agent-fleet workspace.
 *
 * Composition only: every structural part of this screen — the three-panel
 * frame, the tab strip, the nav rails, the grid/list canvas — comes from
 * `stuffbucket-electron/renderer`. What is written here is the arrangement,
 * the filter state, and the wiring to the workspace data source. Nothing here
 * re-implements a primitive the shell already ships.
 *
 * Mounting is deliberately somebody else's decision: this module exports a
 * component and touches no root.
 */

/**
 * Namespaces the persisted panel sizes. `ShellLayout` derives the tab id base
 * from it as `${layoutId}-documents`; `TAB_ID_BASE` below mirrors that so the
 * ids this component references are the ids the shell actually renders. The
 * pair must move together.
 */
const LAYOUT_ID = 'maximal-workspace'
const TAB_ID_BASE = `${LAYOUT_ID}-documents`

/**
 * The runs document. A string id rather than a union member so a terminal tab
 * (or any other document the shell can host) can join this strip later without
 * changing the identity model.
 */
const RUNS_TAB_ID = 'runs'

const ALL_PROJECTS = 'project:all'
const ALL_STATUSES = 'status:all'

type ProjectFilterId = typeof ALL_PROJECTS | `project:${string}`
type StatusFilterId = typeof ALL_STATUSES | `status:${RunStatus}`

const STATUS_ORDER: readonly RunStatus[] = ['running', 'needs-approval', 'done', 'failed']

const EMPTY_SNAPSHOT: WorkspaceSnapshot = { projects: [], runs: [] }

/*
 * Spacing and radius are read the way the package's own stylesheet reads them:
 * `var(--shell-space-4, 16px)`. Those tokens are "fallback" variables in the
 * shell's published contract — a host is not required to define them, and the
 * shipped rules (`.canvas`, `.nav`, `.statusbar`) all fall back to these exact
 * numbers. Matching the fallback keeps this header aligned with the canvas
 * underneath it when no host theme is present. Colours are read bare, or with
 * `currentColor`, because those are the host's to define and a wrong guess
 * would be worse than an inherited one.
 */
const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
  gap: 'var(--shell-space-3, 12px)',
  flex: 'none',
  padding: 'var(--shell-space-4, 16px) var(--shell-space-4, 16px) 0',
}

const mainStyle: CSSProperties = {
  display: 'flex',
  flex: 1,
  flexDirection: 'column',
  minWidth: 0,
  minHeight: 0,
}

const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: '1.15em',
  fontWeight: 600,
}

const subheadStyle: CSSProperties = {
  margin: 0,
  color: 'var(--shell-text-subtle, currentColor)',
  fontSize: '0.85em',
}

const toolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--shell-space-1, 4px)',
  flex: 'none',
}

const railsStyle: CSSProperties = {
  display: 'flex',
  flex: 1,
  flexDirection: 'column',
  minHeight: 0,
  overflowY: 'auto',
}

const inspectorStyle: CSSProperties = {
  display: 'flex',
  flex: 1,
  flexDirection: 'column',
  minHeight: 0,
  overflowY: 'auto',
}

/*
 * The placeholder notice.
 *
 * Persistent, non-dismissible, and drawn with geometry as well as colour: a
 * rule down the leading edge and the word "Placeholder" in bold survive a host
 * that defines no warning colour, a monochrome display, and a screen reader.
 * It sits in `ShellLayout`'s `top` slot, which is the full-width band under the
 * title bar — the slot the shell documents for anything addressing the whole
 * window rather than one panel.
 */
const placeholderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 'var(--shell-space-2, 8px)',
  flex: 'none',
  padding: 'var(--shell-space-2, 8px) var(--shell-space-4, 16px)',
  color: 'var(--shell-text, currentColor)',
  background: 'var(--shell-accent-muted, transparent)',
  borderBottom: '1px solid var(--shell-border, currentColor)',
  borderLeft: '3px solid var(--shell-warning, currentColor)',
  fontSize: '0.9em',
}

const emptyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 'var(--shell-space-2, 8px)',
  maxWidth: '46ch',
  color: 'var(--shell-text-muted, currentColor)',
}

/*
 * Icons.
 *
 * `NavRail` requires a component per entry. These are local SVGs rather than
 * `lucide-react` imports because the client does not depend on lucide directly
 * — it is an optional peer of the shell. They take the `size` the rail passes,
 * draw in `currentColor` so the rail's own selected/hover colours apply, and
 * are hidden from assistive technology: the entry's label carries the meaning.
 */
type IconProps = { size?: number }

function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: 'false' as const,
  }
}

function AllRunsIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="2" y="2.5" width="5" height="5" rx="1" />
      <rect x="9" y="2.5" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="4.5" rx="1" />
      <rect x="9" y="9" width="5" height="4.5" rx="1" />
    </svg>
  )
}

function RunningIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.6V8l2.3 1.5" />
    </svg>
  )
}

function ApprovalIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M8 2.2 14.2 13H1.8Z" />
      <path d="M8 6.4v3" />
      <path d="M8 11.2h.01" />
    </svg>
  )
}

function DoneIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="m5.5 8.2 1.8 1.8 3.2-3.7" />
    </svg>
  )
}

function FailedIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="m6 6 4 4m0-4-4 4" />
    </svg>
  )
}

function ProjectIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M2 4.2a1 1 0 0 1 1-1h2.7l1.3 1.6H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />
    </svg>
  )
}

function GridIcon({ size = 15 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="2" y="2.5" width="5" height="5" rx="1" />
      <rect x="9" y="2.5" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="4.5" rx="1" />
      <rect x="9" y="9" width="5" height="4.5" rx="1" />
    </svg>
  )
}

function ListIcon({ size = 15 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M2.6 4.5h10.8M2.6 8h10.8M2.6 11.5h10.8" />
    </svg>
  )
}

const STATUS_ICONS: Record<RunStatus, (props: IconProps) => React.JSX.Element> = {
  running: RunningIcon,
  'needs-approval': ApprovalIcon,
  done: DoneIcon,
  failed: FailedIcon,
}

function statusIcon(entry: NavRailEntry<StatusFilterId, RunStatus>) {
  return entry.status ? STATUS_ICONS[entry.status] : AllRunsIcon
}

function projectIcon(entry: NavRailEntry<ProjectFilterId>) {
  return entry.id === ALL_PROJECTS ? AllRunsIcon : ProjectIcon
}

export function Workspace({ source }: { source: WorkspaceSource }) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const [projectFilter, setProjectFilter] = useState<ProjectFilterId>(ALL_PROJECTS)
  const [statusFilter, setStatusFilter] = useState<StatusFilterId>(ALL_STATUSES)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<CanvasViewMode>('grid')
  const [activeTabId, setActiveTabId] = useState<string>(RUNS_TAB_ID)

  const headingId = useId()
  const placeholderId = useId()

  /*
   * One effect owns the whole subscription lifetime: the first snapshot, every
   * later change, and the teardown. `settled` stops a late promise writing into
   * an unmounted tree, and the unsubscribe returned by the source is always
   * called — including when `source` is swapped for another one.
   */
  useEffect(() => {
    let settled = false

    setSnapshot(null)
    setError(null)

    source
      .snapshot()
      .then((next) => {
        if (!settled) setSnapshot(next)
      })
      .catch((cause: unknown) => {
        if (!settled) setError(cause instanceof Error ? cause.message : String(cause))
      })

    const unsubscribe = source.subscribe((next) => {
      if (!settled) {
        setSnapshot(next)
        setError(null)
      }
    })

    return () => {
      settled = true
      unsubscribe()
    }
  }, [source, reloadKey])

  const data = snapshot ?? EMPTY_SNAPSHOT
  const loading = snapshot === null && error === null

  const projectName = useMemo(() => {
    if (projectFilter === ALL_PROJECTS) return null
    const id = projectFilter.slice('project:'.length)
    return data.projects.find((project) => project.id === id)?.name ?? null
  }, [data.projects, projectFilter])

  /*
   * Two scopes, because the counts have to mean something. The status rail
   * counts runs inside the selected project, so "Running 2" is a promise the
   * canvas keeps when it is clicked.
   */
  const projectScopedRuns = useMemo(
    () => (projectName === null ? data.runs : data.runs.filter((run) => run.project === projectName)),
    [data.runs, projectName],
  )

  const statusCounts = useMemo(
    () => deriveStatusCounts({ projects: data.projects, runs: projectScopedRuns }),
    [data.projects, projectScopedRuns],
  )

  const visibleRuns = useMemo(() => {
    if (statusFilter === ALL_STATUSES) return projectScopedRuns
    const status = statusFilter.slice('status:'.length) as RunStatus
    return projectScopedRuns.filter((run) => run.status === status)
  }, [projectScopedRuns, statusFilter])

  // Derived, not mirrored: a selection whose run left the snapshot resolves to
  // null on its own rather than needing an effect to clean it up.
  const selectedRun: AgentRun | null = useMemo(
    () => data.runs.find((run) => run.id === selectedRunId) ?? null,
    [data.runs, selectedRunId],
  )

  const projectSections: NavRailSection<ProjectFilterId>[] = useMemo(
    () => [
      {
        id: 'projects',
        label: 'Projects',
        items: [
          { id: ALL_PROJECTS, label: 'All projects', count: data.runs.length },
          // Derived from `data.runs`, not read from `project.runCount`: the
          // stored field has no relational constraint tying it to the run
          // list (see workspace/model.ts), so trusting it here could show a
          // rail count that disagrees with the canvas beneath it. See
          // `runsForProject` in `./source` — the same derivation
          // `dashboard/derive.ts` uses for its per-project rollups.
          ...data.projects.map((project) => ({
            id: `project:${project.id}` as ProjectFilterId,
            label: project.name,
            count: runsForProject(data.runs, project.name).length,
          })),
        ],
      },
    ],
    [data.projects, data.runs],
  )

  const statusSections: NavRailSection<StatusFilterId, RunStatus>[] = useMemo(
    () => [
      {
        id: 'agents',
        label: 'Agents',
        items: [
          { id: ALL_STATUSES, label: 'All runs', count: statusCounts.all },
          ...STATUS_ORDER.map((status) => ({
            id: `status:${status}` as StatusFilterId,
            label: statusLabel[status],
            count: statusCounts[status],
            status,
          })),
        ],
      },
    ],
    [statusCounts],
  )

  /*
   * The document strip. One runs tab today, typed as the shell's `Tab` so a
   * terminal tab can be appended without changing anything here but the array.
   * The emphasis is data, not decoration: `adornmentLabel` inside the shell
   * turns it into words, so the marker is never the only carrier of the signal.
   */
  const tabs: Tab[] = useMemo(() => {
    const needsApproval = data.runs.some((run) => run.status === 'needs-approval')
    const running = data.runs.some((run) => run.status === 'running')
    return [
      {
        id: RUNS_TAB_ID,
        title: 'Agent fleet',
        icon: 'folder',
        emphasis: needsApproval ? 'attention' : running ? 'busy' : undefined,
      },
    ]
  }, [data.runs])

  const clearFilters = useCallback(() => {
    setProjectFilter(ALL_PROJECTS)
    setStatusFilter(ALL_STATUSES)
  }, [])

  const isPlaceholder = source.kind !== 'live'
  const panelId = getTabPanelId(TAB_ID_BASE, activeTabId)
  const triggerId = getTabTriggerId(TAB_ID_BASE, activeTabId)

  const heading = statusFilter === ALL_STATUSES ? 'All runs' : statusLabel[statusFilter.slice('status:'.length) as RunStatus]
  const scope = projectName ?? 'All projects'
  const filtered = projectFilter !== ALL_PROJECTS || statusFilter !== ALL_STATUSES

  const empty = (
    <div style={emptyStyle}>
      {loading ? (
        <p>Loading runs…</p>
      ) : error !== null ? (
        <>
          <p>
            <strong>Couldn&rsquo;t load runs.</strong> {error}
          </p>
          <button type="button" onClick={() => setReloadKey((key) => key + 1)}>
            Try again
          </button>
        </>
      ) : data.runs.length === 0 ? (
        <>
          <p>
            <strong>No agent runs yet.</strong>
          </p>
          <p>
            Runs appear here as agents start work. Each one shows its project, branch, model, and what
            it is doing right now.
          </p>
        </>
      ) : (
        <>
          <p>
            <strong>No runs match this filter.</strong>
          </p>
          <p>
            {data.runs.length} {data.runs.length === 1 ? 'run' : 'runs'} exist in other projects or
            other states.
          </p>
          <button type="button" onClick={clearFilters}>
            Show all runs
          </button>
        </>
      )}
    </div>
  )

  return (
    <ShellLayout
      layoutId={LAYOUT_ID}
      tabs={tabs}
      activeTab={activeTabId}
      onSelectTab={setActiveTabId}
      tabsLabel="Workspace documents"
      top={
        isPlaceholder ? (
          /*
           * Requirement, not decoration: nobody may mistake this for a live
           * fleet. It cannot be dismissed, it is rendered for the entire life
           * of a placeholder source, and it is announced — `role="note"` puts
           * it in the accessibility tree, and the runs region below points at
           * it with `aria-describedby`, so it is read on arrival rather than
           * only when someone happens to navigate past it.
           */
          <div id={placeholderId} role="note" style={placeholderStyle} data-testid="placeholder-notice">
            <strong>Placeholder data</strong>
            <span>
              Nothing on this screen is a real agent run. These runs, projects, branches, and counts
              are fixed sample values shown so the layout can be reviewed before live data exists.
            </span>
          </div>
        ) : undefined
      }
      left={(collapsed) => (
        <div style={railsStyle}>
          {/*
           * Two rails rather than one with two sections: a project and a status
           * are chosen independently, and `NavRail` carries one `current` per
           * rail. One rail would have to forget one of the two selections, and
           * `aria-current` would then lie about the other.
           */}
          <NavRail
            sections={projectSections}
            current={projectFilter}
            onSelect={setProjectFilter}
            collapsed={collapsed}
            icon={projectIcon}
            label="Projects"
            testId="projects-nav"
          />
          <NavRail
            sections={statusSections}
            current={statusFilter}
            onSelect={setStatusFilter}
            collapsed={collapsed}
            icon={statusIcon}
            label="Runs by status"
            testId="status-nav"
          />
        </div>
      )}
      main={
        <section
          style={mainStyle}
          // Named by its tab and its heading; described by the placeholder
          // notice when there is one. The ids come from the shell's own
          // helpers so they cannot drift from the strip it renders.
          aria-labelledby={`${triggerId} ${headingId}`}
          aria-describedby={isPlaceholder ? placeholderId : undefined}
        >
          <header style={headerStyle}>
            <div>
              <h1 id={headingId} style={headingStyle}>
                {heading}
              </h1>
              <p style={subheadStyle}>
                {scope} · {visibleRuns.length} {visibleRuns.length === 1 ? 'run' : 'runs'}
                {isPlaceholder ? ' · placeholder data' : ''}
              </p>
            </div>
            <div style={toolbarStyle} role="group" aria-label="Run layout">
              <IconButton
                label="Grid view"
                active={viewMode === 'grid'}
                aria-pressed={viewMode === 'grid'}
                aria-controls={panelId}
                onClick={() => setViewMode('grid')}
                testId="view-grid"
              >
                <GridIcon />
              </IconButton>
              <IconButton
                label="List view"
                active={viewMode === 'list'}
                aria-pressed={viewMode === 'list'}
                aria-controls={panelId}
                onClick={() => setViewMode('list')}
                testId="view-list"
              >
                <ListIcon />
              </IconButton>
            </div>
          </header>
          <Canvas
            items={visibleRuns}
            mode={viewMode}
            selectedId={selectedRun?.id}
            renderCard={(run, selected) => (
              <RunCard run={run} selected={selected} onSelect={() => setSelectedRunId(run.id)} />
            )}
            renderRow={(run, selected) => (
              <RunCard run={run} selected={selected} onSelect={() => setSelectedRunId(run.id)} />
            )}
            empty={empty}
            label={filtered ? `${heading} in ${scope}` : 'All runs'}
            testId="runs-canvas"
          />
        </section>
      }
      right={
        <aside style={inspectorStyle} aria-label="Run inspector">
          <Inspector run={selectedRun} />
        </aside>
      }
      status={
        <>
          <span>
            {visibleRuns.length} of {data.runs.length} {data.runs.length === 1 ? 'run' : 'runs'}
          </span>
          <span>{statusCounts['needs-approval']} awaiting approval</span>
          {/* The third statement of the same fact, in the one place that is
              always on screen no matter how far the canvas is scrolled. */}
          <span>{isPlaceholder ? 'Placeholder data — not a live fleet' : 'Live data'}</span>
        </>
      }
    />
  )
}
