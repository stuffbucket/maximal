import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { getTabTriggerId, ShellLayout, type Tab } from 'stuffbucket-electron/renderer'
import 'stuffbucket-electron/renderer/styles.css'

import { type WorkspaceSnapshot } from '../workspace/model'
import { type WorkspaceSource } from '../workspace/source'
import { deriveProjectRollups, deriveStatusCounts, selectRecentlyFinished, selectWaitingOnYou } from './derive'
import { FinishedIcon, ProjectsIcon, TotalsIcon } from './icons'
import { PlaceholderBanner } from './PlaceholderBanner'
import { ProjectRollups } from './ProjectRollups'
import { RecentlyFinished } from './RecentlyFinished'
import { SectionNav, type SectionNavItem } from './SectionNav'
import { StatusTotals } from './StatusTotals'
import './styles'
import { WaitingOnYouPanel } from './WaitingOnYouPanel'

/*
 * The dashboard/overview surface.
 *
 * Answers three questions the runs workspace (../workspace/Workspace.tsx)
 * doesn't, because it's built for browsing one run at a time rather than
 * summarizing the fleet: what needs me right now (the waiting-on-you queue,
 * pinned in the right rail — the same content the reference demo's
 * inspector shows by default when nothing is selected), what's in flight
 * (status totals, per-project rollups), and what just finished (done vs.
 * failed, kept separate).
 *
 * Structural composition only, same discipline as Workspace.tsx: the
 * three-panel frame and tab strip come from `stuffbucket-electron/renderer`.
 * All aggregation lives in pure functions in ./derive.ts, not inline here.
 * Mounting is somebody else's decision — this module exports a component and
 * touches no root.
 */

const LAYOUT_ID = 'maximal-dashboard'
const TAB_ID_BASE = `${LAYOUT_ID}-documents`
const OVERVIEW_TAB_ID = 'overview'

const EMPTY_SNAPSHOT: WorkspaceSnapshot = { projects: [], runs: [] }

const SECTION_TOTALS = 'dashboard-section-totals'
const SECTION_PROJECTS = 'dashboard-section-projects'
const SECTION_FINISHED = 'dashboard-section-finished'

export function Dashboard({ source }: { source: WorkspaceSource }) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [currentSection, setCurrentSection] = useState<string | null>(null)

  const headingId = useId()
  const placeholderId = useId()

  const totalsRef = useRef<HTMLDivElement>(null)
  const projectsRef = useRef<HTMLDivElement>(null)
  const finishedRef = useRef<HTMLDivElement>(null)

  /* Same subscription lifetime discipline as Workspace.tsx: one effect owns
   * the first snapshot, every later change, and teardown. `settled` guards
   * against a late promise writing into an unmounted tree. */
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
  const isPlaceholder = source.kind !== 'live'

  const waitingOnYou = useMemo(() => selectWaitingOnYou(data), [data])
  const statusCounts = useMemo(() => deriveStatusCounts(data), [data])
  const projectRollups = useMemo(() => deriveProjectRollups(data), [data])
  const finished = useMemo(() => selectRecentlyFinished(data), [data])

  const sectionItems: SectionNavItem[] = useMemo(
    () => [
      { id: SECTION_TOTALS, label: 'Status totals', count: statusCounts.all, icon: TotalsIcon },
      { id: SECTION_PROJECTS, label: 'Projects', count: data.projects.length, icon: ProjectsIcon },
      {
        id: SECTION_FINISHED,
        label: 'Recently finished',
        count: finished.done.length + finished.failed.length,
        icon: FinishedIcon,
      },
    ],
    [statusCounts.all, data.projects.length, finished.done.length, finished.failed.length],
  )

  const sectionRefs = useMemo(
    () => ({ [SECTION_TOTALS]: totalsRef, [SECTION_PROJECTS]: projectsRef, [SECTION_FINISHED]: finishedRef }),
    [],
  )

  const jumpToSection = useCallback(
    (id: string) => {
      setCurrentSection(id)
      sectionRefs[id as keyof typeof sectionRefs]?.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      })
    },
    [sectionRefs],
  )

  const tabs: Tab[] = useMemo(
    () => [
      {
        id: OVERVIEW_TAB_ID,
        title: 'Overview',
        icon: 'document',
        emphasis: statusCounts['needs-approval'] > 0 ? 'attention' : statusCounts.running > 0 ? 'busy' : undefined,
      },
    ],
    [statusCounts],
  )

  const triggerId = getTabTriggerId(TAB_ID_BASE, OVERVIEW_TAB_ID)

  const rightContent =
    loading ? (
      <aside className="dashboard-waiting" aria-label="Waiting on you">
        <p className="dashboard__empty-text">Loading…</p>
      </aside>
    ) : error !== null ? (
      <aside className="dashboard-waiting" aria-label="Waiting on you">
        <p className="dashboard__empty-text">Couldn&rsquo;t load the fleet.</p>
      </aside>
    ) : (
      <WaitingOnYouPanel runs={waitingOnYou} />
    )

  return (
    <ShellLayout
      layoutId={LAYOUT_ID}
      tabs={tabs}
      activeTab={OVERVIEW_TAB_ID}
      onSelectTab={() => {}}
      tabsLabel="Dashboard documents"
      top={isPlaceholder ? <PlaceholderBanner id={placeholderId} /> : undefined}
      left={(collapsed) => (
        <SectionNav items={sectionItems} current={currentSection} onSelect={jumpToSection} collapsed={collapsed} />
      )}
      main={
        <section
          className="dashboard"
          aria-labelledby={`${triggerId} ${headingId}`}
          aria-describedby={isPlaceholder ? placeholderId : undefined}
        >
          <header>
            <h1 id={headingId} className="dashboard__heading">
              Fleet overview
            </h1>
            <p className="dashboard__subhead">
              {statusCounts.all} {statusCounts.all === 1 ? 'run' : 'runs'} across {data.projects.length}{' '}
              {data.projects.length === 1 ? 'project' : 'projects'}
              {isPlaceholder ? ' · placeholder data' : ''}
            </p>
          </header>

          {loading ? (
            <p className="dashboard__empty-text">Loading fleet…</p>
          ) : error !== null ? (
            <>
              <p className="dashboard__empty-text">
                <strong>Couldn&rsquo;t load the fleet.</strong> {error}
              </p>
              <button
                type="button"
                className="dashboard-retry"
                onClick={() => setReloadKey((key) => key + 1)}
              >
                Try again
              </button>
            </>
          ) : data.runs.length === 0 ? (
            <p className="dashboard__empty-text">
              <strong>No agent runs yet.</strong> Runs appear here — with their status, project, and
              what they're doing — as soon as agents start work.
            </p>
          ) : (
            <>
              <div className="dashboard__section" id={SECTION_TOTALS} ref={totalsRef}>
                <h2 className="dashboard__section-heading">Status totals</h2>
                <StatusTotals counts={statusCounts} />
              </div>

              <div className="dashboard__section" id={SECTION_PROJECTS} ref={projectsRef}>
                <h2 className="dashboard__section-heading">Projects</h2>
                <ProjectRollups rollups={projectRollups} />
              </div>

              <div className="dashboard__section" id={SECTION_FINISHED} ref={finishedRef}>
                <h2 className="dashboard__section-heading">Recently finished</h2>
                <RecentlyFinished finished={finished} />
              </div>
            </>
          )}
        </section>
      }
      right={rightContent}
      status={
        <>
          <span>
            {statusCounts.all} {statusCounts.all === 1 ? 'run' : 'runs'} in the fleet
          </span>
          <span>{statusCounts['needs-approval']} awaiting approval</span>
          <span>{isPlaceholder ? 'Placeholder data — not a live fleet' : 'Live data'}</span>
        </>
      }
    />
  )
}
