import { AgentRun, Project, RunStatus, WorkspaceSnapshot } from './model'

// The adapter seam between the workspace UI and wherever run data actually
// comes from. maximal-core is a Copilot proxy today — it has auth, models,
// and usage, but no durable project catalog and no harness runtime (both are
// explicitly deferred; see stuffbucket/maximal#432 and
// stuffbucket/maximal-core#109). Until core (or something else) can back a
// live source, `createPlaceholderSource` is the only implementation, and its
// `kind` field lets callers — and, ultimately, anyone rendering this data —
// tell placeholder from live at a glance. There is deliberately no
// `createLiveSource` here yet: inventing one would fabricate data that looks
// real but isn't.
export interface WorkspaceSource {
  readonly kind: 'placeholder' | 'live'
  snapshot(): Promise<WorkspaceSnapshot>
  subscribe(onChange: (s: WorkspaceSnapshot) => void): () => void
}

// Fixed, deterministic constants for placeholder elapsed times. No
// Math.random, no Date.now: the same snapshot must render the same way on
// every load so it's obvious this is inert sample data, not a live clock.
const ONE_MINUTE_MS = 60_000
const PLACEHOLDER_ELAPSED_MS = {
  short: 3 * ONE_MINUTE_MS + 41_000, // 3m 41s
  medium: 12 * ONE_MINUTE_MS + 4_000, // 12m 04s
  long: 31 * ONE_MINUTE_MS + 52_000, // 31m 52s
} as const

// Completion times for `done`/`failed` runs, anchored at the Unix epoch
// rather than `Date.now()` — a handful of minutes past 1970-01-01 can never
// be mistaken for a real completion time, which is the point: self-evidently
// placeholder, and identical on every load. `recent` > `earlier` so the two
// finished placeholder runs land in a deterministic, non-tied order.
const PLACEHOLDER_FINISHED_AT_MS = {
  earlier: 2 * ONE_MINUTE_MS,
  recent: 9 * ONE_MINUTE_MS,
} as const

// Names are deliberately fictional and labeled as such so a viewer can never
// mistake this for a real project or a real run.
const placeholderRuns: readonly AgentRun[] = [
  {
    id: 'placeholder-run-1',
    title: '[Placeholder] Add session refresh to auth middleware',
    status: 'running',
    project: 'Placeholder Project — Aurora',
    branch: 'placeholder/session-refresh',
    model: 'placeholder-model',
    activity: 'Editing src/auth/session.ts (3 of 7 files)',
    elapsedMs: PLACEHOLDER_ELAPSED_MS.medium,
    tokens: 18_204,
    diff: { added: 142, removed: 37 },
    toolCalls: { read: 12, edit: 5, bash: 2 },
  },
  {
    id: 'placeholder-run-2',
    title: '[Placeholder] Investigate flaky retry test',
    status: 'needs-approval',
    project: 'Placeholder Project — Aurora',
    branch: 'placeholder/retry-flake',
    model: 'placeholder-model',
    activity: 'Waiting for approval to run bash: npm test',
    elapsedMs: PLACEHOLDER_ELAPSED_MS.long,
    tokens: 41_930,
    diff: { added: 26, removed: 4 },
    toolCalls: { read: 20, edit: 3, bash: 6 },
  },
  {
    id: 'placeholder-run-3',
    title: '[Placeholder] Draft changelog for v0.5',
    status: 'done',
    project: 'Placeholder Project — Borealis',
    branch: 'placeholder/changelog-v0-5',
    model: 'placeholder-model',
    activity: 'Finished: wrote CHANGELOG.md',
    elapsedMs: PLACEHOLDER_ELAPSED_MS.short,
    tokens: 6_512,
    diff: { added: 58, removed: 0 },
    toolCalls: { read: 4, edit: 1, bash: 0 },
    finishedAt: PLACEHOLDER_FINISHED_AT_MS.recent,
  },
  {
    id: 'placeholder-run-4',
    title: '[Placeholder] Port config loader to zod',
    status: 'failed',
    project: 'Placeholder Project — Borealis',
    branch: 'placeholder/config-zod-port',
    model: 'placeholder-model',
    activity: 'Stopped: type error in src/config/loader.ts',
    elapsedMs: PLACEHOLDER_ELAPSED_MS.medium,
    tokens: 9_877,
    diff: { added: 63, removed: 41 },
    toolCalls: { read: 9, edit: 4, bash: 1 },
    finishedAt: PLACEHOLDER_FINISHED_AT_MS.earlier,
  },
]

/**
 * Runs belonging to a project, matched by name. This is the one place "which
 * runs belong to this project" is decided — `Project.runCount` is a stored
 * field with no relational constraint tying it to the run list (see
 * `model.ts`), so any surface that needs a per-project count must derive it
 * from `runs` through here rather than trusting the stored field or
 * re-implementing the filter, both of which can drift from the runs they're
 * supposed to describe.
 */
export function runsForProject(runs: readonly AgentRun[], projectName: string): AgentRun[] {
  return runs.filter((run) => run.project === projectName)
}

function projectRunCount(projectName: string, runs: readonly AgentRun[]): number {
  return runsForProject(runs, projectName).length
}

function buildPlaceholderSnapshot(): WorkspaceSnapshot {
  const runs = placeholderRuns
  const projectNames = [...new Set(runs.map((run) => run.project))]
  const projects: Project[] = projectNames.map((name, index) => ({
    id: `placeholder-project-${index + 1}`,
    name,
    // Derived from the run list itself, never stated separately, so the
    // count can't drift out of sync with what it's counting.
    runCount: projectRunCount(name, runs),
  }))

  return WorkspaceSnapshot.parse({ projects, runs })
}

export function createPlaceholderSource(): WorkspaceSource {
  const snapshot = buildPlaceholderSnapshot()

  return {
    kind: 'placeholder',
    snapshot: () => Promise.resolve(snapshot),
    subscribe: () => {
      // Placeholder data never changes, so there is nothing to notify. The
      // returned unsubscribe is a no-op for symmetry with a live source.
      return () => {}
    },
  }
}

/** Per-status run counts for the filter rail, plus an `all` total. */
export function deriveStatusCounts(snapshot: WorkspaceSnapshot): Record<RunStatus, number> & { all: number } {
  const counts: Record<RunStatus, number> = {
    running: 0,
    'needs-approval': 0,
    done: 0,
    failed: 0,
  }

  for (const run of snapshot.runs) {
    counts[run.status] += 1
  }

  return { ...counts, all: snapshot.runs.length }
}
