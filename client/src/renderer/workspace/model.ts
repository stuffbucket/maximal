import { z } from 'zod'

// Shapes for the agent-fleet workspace: a projects rail with run counts,
// status filters, run cards, and an inspector. See stuffbucket/maximal#432.
//
// maximal-core cannot back this data yet (it has no concept of projects,
// agent runs, branches, tool calls, or diffs — see maximal-core#109), so
// these schemas describe the model the UI renders against, independent of
// where the data ultimately comes from. The adapter seam lives in
// ./source.ts.

export const RunStatus = z.enum(['running', 'needs-approval', 'done', 'failed'])
export type RunStatus = z.infer<typeof RunStatus>

export const ToolCallCounts = z.object({
  read: z.number().int().nonnegative(),
  edit: z.number().int().nonnegative(),
  bash: z.number().int().nonnegative(),
})
export type ToolCallCounts = z.infer<typeof ToolCallCounts>

export const DiffStat = z.object({
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
})
export type DiffStat = z.infer<typeof DiffStat>

const FINISHED_STATUSES: readonly RunStatus[] = ['done', 'failed']

export const AgentRun = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: RunStatus,
    project: z.string().min(1),
    branch: z.string().min(1),
    model: z.string().min(1),
    activity: z.string(), // e.g. "Editing src/auth/session.ts (3 of 7 files)"
    elapsedMs: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    diff: DiffStat,
    toolCalls: ToolCallCounts,
    // Epoch ms when the run finished. Optional, not required: a `running` or
    // `needs-approval` run has not finished, and this field must never carry
    // a fabricated value pretending otherwise. The `.refine` below is what
    // makes that a guarantee instead of a convention — it ties presence of
    // this field to `status` so a `done`/`failed` run can't silently lack a
    // timestamp and an in-flight run can't silently gain one. A
    // status-keyed discriminated union would state the same rule in the
    // type system instead of a refinement, but every consumer here
    // (RunCard.tsx, Inspector.tsx, Workspace.tsx) destructures a flat
    // `AgentRun` without narrowing on `status` first — a union would force
    // narrowing everywhere just to read `elapsedMs`, for no benefit those
    // call sites need.
    finishedAt: z.number().int().nonnegative().optional(),
  })
  .refine((run) => FINISHED_STATUSES.includes(run.status) === (run.finishedAt !== undefined), {
    message: '`finishedAt` must be set for done/failed runs, and only for those runs',
    path: ['finishedAt'],
  })
export type AgentRun = z.infer<typeof AgentRun>

export const Project = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  runCount: z.number().int().nonnegative(),
})
export type Project = z.infer<typeof Project>

export const WorkspaceSnapshot = z.object({
  projects: z.array(Project),
  runs: z.array(AgentRun),
})
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshot>

/** Display text for each RunStatus, keyed for use in filter rails and run cards. */
export const statusLabel: Record<RunStatus, string> = {
  running: 'Running',
  'needs-approval': 'Needs approval',
  done: 'Done',
  failed: 'Failed',
}

/** Formats elapsed milliseconds as "12m 04s" / "31m 52s". */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}
