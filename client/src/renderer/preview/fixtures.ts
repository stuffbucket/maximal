export type RunStatus = 'running' | 'blocked' | 'done' | 'failed'

export interface ToolCallFixture {
  name: string
  calls: number
  level: 'low' | 'medium' | 'high'
}

export interface WorkspaceRunFixture {
  id: string
  project: ProjectId
  branch: string
  task: string
  status: RunStatus
  model: string
  elapsed: string
  step: string
  tools: ToolCallFixture[]
  tokens: string
  diff: string
  pendingTool?: string
  pendingSummary?: string
}

export type ProjectId = 'maximal' | 'maximal-core' | 'electron'
export type WorkspaceViewId = 'all' | `project:${ProjectId}` | `status:${RunStatus}`

export interface SessionTabFixture {
  id: string
  title: string
  status?: RunStatus
}

export const STATUS_LABELS: Record<RunStatus, string> = {
  running: 'Running',
  blocked: 'Needs approval',
  done: 'Done',
  failed: 'Failed',
}

export const WORKSPACE_RUNS: WorkspaceRunFixture[] = [
  {
    id: 'run-101',
    project: 'maximal',
    branch: 'feat/electron-spatial-ui',
    task: 'Compose the first spatial workspace preview',
    status: 'running',
    model: 'claude-opus-5',
    elapsed: '12m 04s',
    step: 'Refining the run queue and inspector hierarchy',
    tools: [
      { name: 'read', calls: 31, level: 'high' },
      { name: 'edit', calls: 9, level: 'medium' },
      { name: 'bash', calls: 4, level: 'low' },
    ],
    tokens: '184.2k',
    diff: '+312 −188',
  },
  {
    id: 'run-102',
    project: 'maximal-core',
    branch: 'agent/flaky-triage',
    task: 'Triage the flaky provider retry test',
    status: 'blocked',
    model: 'claude-sonnet-4-6',
    elapsed: '4m 41s',
    step: 'Waiting for approval to run the mutation suite',
    tools: [
      { name: 'read', calls: 18, level: 'high' },
      { name: 'grep', calls: 12, level: 'medium' },
      { name: 'bash', calls: 2, level: 'low' },
    ],
    tokens: '61.8k',
    diff: '+24 −11',
    pendingTool: 'bash',
    pendingSummary: 'npm run mutate',
  },
  {
    id: 'run-103',
    project: 'electron',
    branch: 'agent/package-export',
    task: 'Verify the renderer package boundary',
    status: 'running',
    model: 'claude-sonnet-4-6',
    elapsed: '2m 18s',
    step: 'Checking public declarations against the packed tarball',
    tools: [
      { name: 'read', calls: 17, level: 'high' },
      { name: 'bash', calls: 3, level: 'low' },
    ],
    tokens: '42.4k',
    diff: '+18 −7',
  },
  {
    id: 'run-104',
    project: 'maximal-core',
    branch: 'agent/token-budget',
    task: 'Add a token budget to the streaming provider',
    status: 'done',
    model: 'claude-opus-5',
    elapsed: '31m 52s',
    step: 'Finished. Fourteen files changed and the suite is green.',
    tools: [
      { name: 'read', calls: 44, level: 'high' },
      { name: 'edit', calls: 21, level: 'high' },
      { name: 'bash', calls: 9, level: 'medium' },
    ],
    tokens: '402.7k',
    diff: '+688 −241',
  },
  {
    id: 'run-105',
    project: 'maximal',
    branch: 'agent/font-package',
    task: 'Keep desktop fonts self-hosted in the package',
    status: 'done',
    model: 'claude-haiku-4-6',
    elapsed: '18m 09s',
    step: 'Finished. Renderer assets resolve without a network request.',
    tools: [
      { name: 'read', calls: 26, level: 'high' },
      { name: 'edit', calls: 8, level: 'medium' },
    ],
    tokens: '141.0k',
    diff: '+204 −96',
  },
  {
    id: 'run-106',
    project: 'electron',
    branch: 'agent/titlebar-overlay',
    task: 'Normalize titlebar behavior across desktop hosts',
    status: 'failed',
    model: 'qwen3-coder-30b',
    elapsed: '7m 27s',
    step: 'Stopped after the Windows host assertion failed.',
    tools: [
      { name: 'read', calls: 15, level: 'high' },
      { name: 'edit', calls: 11, level: 'medium' },
      { name: 'bash', calls: 6, level: 'medium' },
    ],
    tokens: '88.3k',
    diff: '+97 −42',
  },
  {
    id: 'run-107',
    project: 'maximal',
    branch: 'agent/design-gates',
    task: 'Run the generated token freshness gates',
    status: 'running',
    model: 'claude-opus-5',
    elapsed: '9m 33s',
    step: 'Comparing both generated desktop token targets',
    tools: [
      { name: 'read', calls: 22, level: 'high' },
      { name: 'bash', calls: 5, level: 'medium' },
    ],
    tokens: '96.5k',
    diff: '+118 −77',
  },
  {
    id: 'run-108',
    project: 'electron',
    branch: 'agent/overlay-focus',
    task: 'Audit assistant overlay focus behavior',
    status: 'blocked',
    model: 'claude-haiku-4-6',
    elapsed: '1m 56s',
    step: 'Waiting for approval to update the overlay contract',
    tools: [
      { name: 'read', calls: 9, level: 'high' },
      { name: 'grep', calls: 4, level: 'medium' },
    ],
    tokens: '17.9k',
    diff: '+12 −4',
    pendingTool: 'write',
    pendingSummary: 'src/renderer/styles/overlay.css',
  },
]

export const INITIAL_SESSION_TABS: SessionTabFixture[] = [
  { id: 'run-101', title: 'workspace preview', status: 'running' },
  { id: 'run-102', title: 'retry test triage', status: 'blocked' },
  { id: 'run-103', title: 'renderer boundary', status: 'running' },
]
