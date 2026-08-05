import {
  Bot,
  Check,
  CheckCircle2,
  CircleAlert,
  FolderGit2,
  LoaderCircle,
  MessageSquareText,
  PanelRightClose,
  ShieldQuestion,
  Sparkles,
  X,
} from 'lucide-react'
import { useMemo, useState, type ComponentType, type FormEvent } from 'react'
import { Canvas, IconButton, NavRail, ShellLayout, type NavRailEntry } from 'stuffbucket-electron/renderer'

import {
  INITIAL_SESSION_TABS,
  STATUS_LABELS,
  WORKSPACE_RUNS,
  type ProjectId,
  type RunStatus,
  type SessionTabFixture,
  type WorkspaceRunFixture,
  type WorkspaceViewId,
} from './fixtures'

const PROJECTS: ProjectId[] = ['maximal', 'maximal-core', 'electron']
const RUN_STATUSES: RunStatus[] = ['running', 'blocked', 'done', 'failed']

const STATUS_ICONS: Record<RunStatus, ComponentType<{ size?: number }>> = {
  running: LoaderCircle,
  blocked: ShieldQuestion,
  done: CheckCircle2,
  failed: CircleAlert,
}

function countRuns(runs: WorkspaceRunFixture[], status: RunStatus): number {
  return runs.filter((run) => run.status === status).length
}

function runsForView(runs: WorkspaceRunFixture[], view: WorkspaceViewId): WorkspaceRunFixture[] {
  if (view.startsWith('project:')) {
    return runs.filter((run) => run.project === view.slice('project:'.length))
  }
  if (view.startsWith('status:')) {
    return runs.filter((run) => run.status === view.slice('status:'.length))
  }
  return runs
}

function viewLabel(view: WorkspaceViewId): string {
  if (view === 'all') return 'Run queue'
  const value = view.slice(view.indexOf(':') + 1)
  return value === 'blocked' ? 'Needs approval' : value
}

function navIcon(entry: NavRailEntry<WorkspaceViewId, RunStatus>): ComponentType<{ size?: number }> {
  if (entry.status) return STATUS_ICONS[entry.status]
  return entry.id === 'all' ? Bot : FolderGit2
}

function RunRow({
  run,
  selected,
  onSelect,
}: {
  run: WorkspaceRunFixture
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      className="workspace-preview__run-row"
      data-selected={selected}
      data-status={run.status}
      onClick={onSelect}
      aria-label={`${run.task}, ${STATUS_LABELS[run.status]}`}
    >
      <span className="workspace-preview__status-dot" aria-hidden="true" />
      <span className="workspace-preview__run-task">{run.task}</span>
      <span className="workspace-preview__run-project">{run.project}</span>
      <span className="workspace-preview__run-model">{run.model}</span>
      <span className="workspace-preview__run-tokens">{run.tokens}</span>
      <span className="workspace-preview__run-elapsed">{run.elapsed}</span>
    </button>
  )
}

function ApprovalActions({
  run,
  onDecision,
}: {
  run: WorkspaceRunFixture
  onDecision: (id: string, allow: boolean) => void
}) {
  return (
    <section className="workspace-preview__approval" aria-labelledby="preview-approval-title">
      <h3 id="preview-approval-title">Waiting on you</h3>
      <p>
        <code>{run.pendingTool ?? 'tool'}</code>
        <span>{run.pendingSummary ?? run.step}</span>
      </p>
      <div className="workspace-preview__approval-actions">
        <button type="button" className="workspace-preview__button workspace-preview__button--primary" onClick={() => onDecision(run.id, true)}>
          <Check aria-hidden="true" /> Allow
        </button>
        <button type="button" className="workspace-preview__button" onClick={() => onDecision(run.id, false)}>
          <X aria-hidden="true" /> Deny
        </button>
      </div>
    </section>
  )
}

function RunInspector({
  run,
  onCollapse,
  onDecision,
}: {
  run: WorkspaceRunFixture | undefined
  onCollapse: () => void
  onDecision: (id: string, allow: boolean) => void
}) {
  return (
    <aside className="workspace-preview__inspector" aria-label="Selected run inspector">
      <header className="workspace-preview__inspector-header">
        <span>Agent run</span>
        <IconButton label="Collapse inspector" onClick={onCollapse}>
          <PanelRightClose aria-hidden="true" />
        </IconButton>
      </header>
      {run ? (
        <div className="workspace-preview__inspector-scroll">
          <section className="workspace-preview__inspector-intro">
            <span className="workspace-preview__status-label" data-status={run.status}>{STATUS_LABELS[run.status]}</span>
            <h2>{run.task}</h2>
            <p>{run.step}</p>
          </section>
          {run.status === 'blocked' ? <ApprovalActions run={run} onDecision={onDecision} /> : null}
          <section className="workspace-preview__details" aria-labelledby="preview-details-title">
            <h3 id="preview-details-title">Details</h3>
            <dl>
              <div><dt>Project</dt><dd>{run.project}</dd></div>
              <div><dt>Branch</dt><dd>{run.branch}</dd></div>
              <div><dt>Model</dt><dd>{run.model}</dd></div>
              <div><dt>Elapsed</dt><dd>{run.elapsed}</dd></div>
              <div><dt>Tokens</dt><dd>{run.tokens}</dd></div>
              <div><dt>Diff</dt><dd>{run.diff}</dd></div>
            </dl>
          </section>
          <section className="workspace-preview__tools" aria-labelledby="preview-tools-title">
            <h3 id="preview-tools-title">Tool calls</h3>
            <ul>
              {run.tools.map((tool) => (
                <li key={tool.name}>
                  <code>{tool.name}</code>
                  <span className="workspace-preview__tool-meter" data-level={tool.level}><span /></span>
                  <span>{tool.calls}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : (
        <p className="workspace-preview__empty-inspector">Select a run to inspect its current step and tool activity.</p>
      )}
    </aside>
  )
}

function AssistantOverlay({ onClose }: { onClose: () => void }) {
  const [message, setMessage] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [approval, setApproval] = useState<'pending' | 'allowed' | 'denied'>('pending')

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!message.trim()) return
    setStreaming(true)
    setMessage('')
  }

  return (
    <section className="workspace-preview__assistant" role="dialog" aria-modal="false" aria-labelledby="preview-assistant-title">
      <header>
        <span className="workspace-preview__assistant-mark"><Sparkles aria-hidden="true" /></span>
        <div>
          <h2 id="preview-assistant-title">Workspace assistant</h2>
          <p>Concept preview · local fixture</p>
        </div>
        <IconButton label="Close assistant" onClick={onClose}><X aria-hidden="true" /></IconButton>
      </header>
      <div className="workspace-preview__assistant-thread" aria-live="polite">
        <div className="workspace-preview__assistant-message">
          <span>Assistant</span>
          <p>I found one blocked verification step. I can approve the mutation run and keep watching its output.</p>
        </div>
        {approval === 'pending' ? (
          <div className="workspace-preview__assistant-approval">
            <p><code>bash</code> npm run mutate</p>
            <div>
              <button type="button" className="workspace-preview__button" onClick={() => setApproval('denied')}>Deny</button>
              <button type="button" className="workspace-preview__button workspace-preview__button--primary" onClick={() => setApproval('allowed')}>Allow</button>
            </div>
          </div>
        ) : (
          <p className="workspace-preview__assistant-decision">Fixture decision: {approval}.</p>
        )}
        {streaming ? (
          <div className="workspace-preview__assistant-message">
            <span>Assistant · streaming concept</span>
            <p>The run queue is updating from your request. The production assistant is not connected in this preview.</p>
            <button type="button" className="workspace-preview__text-action" onClick={() => setStreaming(false)}>Finish concept response</button>
          </div>
        ) : null}
      </div>
      <form onSubmit={submit}>
        <label htmlFor="preview-assistant-message">Ask about this workspace</label>
        <div>
          <input id="preview-assistant-message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Summarize blocked runs" />
          <button type="submit" className="workspace-preview__button workspace-preview__button--primary" disabled={!message.trim()}>Send</button>
        </div>
      </form>
    </section>
  )
}

export function WorkspacePreview() {
  const [runs, setRuns] = useState(WORKSPACE_RUNS)
  const [view, setView] = useState<WorkspaceViewId>('all')
  const [selectedId, setSelectedId] = useState('run-102')
  const [tabs, setTabs] = useState<SessionTabFixture[]>(INITIAL_SESSION_TABS)
  const [activeTab, setActiveTab] = useState('run-102')
  const [assistantOpen, setAssistantOpen] = useState(false)

  const visibleRuns = useMemo(() => runsForView(runs, view), [runs, view])
  const selectedRun = runs.find((run) => run.id === selectedId)
  const navSections = useMemo(() => [
    {
      id: 'projects',
      label: 'Projects',
      items: PROJECTS.map((project) => ({
        id: `project:${project}` as WorkspaceViewId,
        label: project,
        count: runs.filter((run) => run.project === project).length,
      })),
    },
    {
      id: 'agents',
      label: 'Agents',
      items: [
        { id: 'all' as WorkspaceViewId, label: 'All runs', count: runs.length },
        ...RUN_STATUSES.map((status) => ({
          id: `status:${status}` as WorkspaceViewId,
          label: STATUS_LABELS[status],
          count: countRuns(runs, status),
          status,
        })),
      ],
    },
  ], [runs])

  function selectRun(id: string): void {
    setSelectedId(id)
    if (tabs.some((tab) => tab.id === id)) setActiveTab(id)
  }

  function selectTab(id: string): void {
    setActiveTab(id)
    if (runs.some((run) => run.id === id)) setSelectedId(id)
  }

  function closeTab(id: string): void {
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== id)
      if (id === activeTab && next[0]) selectTab(next[0].id)
      return next
    })
  }

  function addSession(): void {
    const candidate = runs.find((run) => !tabs.some((tab) => tab.id === run.id))
    if (!candidate) return
    setTabs((current) => [...current, { id: candidate.id, title: candidate.task, status: candidate.status }])
    selectRun(candidate.id)
    setActiveTab(candidate.id)
  }

  function decideRun(id: string, allow: boolean): void {
    setRuns((current) => current.map((run) => run.id === id ? {
      ...run,
      status: allow ? 'running' : 'failed',
      step: allow ? 'Approval granted. Starting the requested tool call.' : 'Tool call denied in the concept preview.',
      pendingTool: undefined,
      pendingSummary: undefined,
    } : run))
    setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, status: allow ? 'running' : 'failed' } : tab))
  }

  const runningCount = countRuns(runs, 'running')
  const blockedCount = countRuns(runs, 'blocked')

  return (
    <main className="workspace-preview" data-theme="dark" aria-label="Maximal workspace concept preview using deterministic local fixture data">
      <p className="workspace-preview__sr-only">This is an interactive concept preview. Its agent runs and assistant responses are fixture data and are unavailable in production.</p>
      <ShellLayout
        layoutId="maximal-workspace-concept"
        tabs={tabs}
        activeTab={activeTab}
        onSelectTab={selectTab}
        onCloseTab={closeTab}
        onNewTab={addSession}
        tabsLabel="Concept session tabs"
        newTabLabel="Open another fixture session"
        titleBarActions={(
          <IconButton label={assistantOpen ? 'Close workspace assistant concept' : 'Open workspace assistant concept'} active={assistantOpen} onClick={() => setAssistantOpen((open) => !open)}>
            <MessageSquareText aria-hidden="true" />
          </IconButton>
        )}
        leftSize={{ default: '18', min: '14', max: '26', collapsed: '5' }}
        rightSize={{ default: '25', min: '20', max: '36', collapsed: '0' }}
        left={(collapsed) => (
          <NavRail sections={navSections} current={view} onSelect={setView} collapsed={collapsed} icon={navIcon} label="Workspace projects and agent status" />
        )}
        main={(
          <section className="workspace-preview__queue" aria-labelledby="preview-queue-title">
            <header className="workspace-preview__queue-header">
              <div>
                <span>Interactive fixture</span>
                <h1 id="preview-queue-title">{viewLabel(view)}</h1>
              </div>
              <span>{visibleRuns.length} runs</span>
            </header>
            <div className="workspace-preview__column-head" aria-hidden="true">
              <span>Run</span><span>Project</span><span>Model</span><span>Tokens</span><span>Elapsed</span>
            </div>
            <Canvas
              items={visibleRuns}
              mode="list"
              selectedId={selectedId}
              label={`${viewLabel(view)} fixture runs`}
              empty={<p className="workspace-preview__empty">No fixture runs match this view.</p>}
              renderCard={(run, selected) => <RunRow run={run} selected={selected} onSelect={() => selectRun(run.id)} />}
              renderRow={(run, selected) => <RunRow run={run} selected={selected} onSelect={() => selectRun(run.id)} />}
            />
          </section>
        )}
        right={(collapse) => <RunInspector run={selectedRun} onCollapse={collapse} onDecision={decideRun} />}
        status={(
          <div className="workspace-preview__statusbar">
            <span>{runningCount} running</span>
            <span>{blockedCount} waiting on approval</span>
            <span>Fixture data · concept preview</span>
          </div>
        )}
      />
      {assistantOpen ? <AssistantOverlay onClose={() => setAssistantOpen(false)} /> : null}
    </main>
  )
}
