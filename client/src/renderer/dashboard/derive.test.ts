import { describe, expect, it } from 'vitest'

import type { AgentRun, WorkspaceSnapshot } from '../workspace/model'
import { selectRecentlyFinished } from './derive'

// Minimal but schema-shaped fixture: every field `selectRecentlyFinished`
// doesn't care about is filled with an inert placeholder value so each test
// case only has to vary what it's actually testing.
function run(overrides: Partial<AgentRun> & Pick<AgentRun, 'id' | 'status'>): AgentRun {
  return {
    title: `[Test] ${overrides.id}`,
    project: 'Test Project',
    branch: 'test/branch',
    model: 'test-model',
    activity: 'idle',
    elapsedMs: 0,
    tokens: 0,
    diff: { added: 0, removed: 0 },
    toolCalls: { read: 0, edit: 0, bash: 0 },
    ...overrides,
  }
}

function snapshotOf(runs: readonly AgentRun[]): WorkspaceSnapshot {
  return { projects: [], runs: [...runs] }
}

describe('selectRecentlyFinished', () => {
  it('orders each outcome bucket most-recently-finished first', () => {
    const oldest = run({ id: 'done-oldest', status: 'done', finishedAt: 1_000 })
    const newest = run({ id: 'done-newest', status: 'done', finishedAt: 5_000 })
    const middle = run({ id: 'done-middle', status: 'done', finishedAt: 3_000 })

    const { done } = selectRecentlyFinished(snapshotOf([oldest, newest, middle]))

    expect(done.map((r) => r.id)).toEqual(['done-newest', 'done-middle', 'done-oldest'])
  })

  it('keeps done and failed in separate, independently ordered buckets', () => {
    const doneNewer = run({ id: 'done-newer', status: 'done', finishedAt: 9_000 })
    const doneOlder = run({ id: 'done-older', status: 'done', finishedAt: 1_000 })
    const failedNewer = run({ id: 'failed-newer', status: 'failed', finishedAt: 8_000 })
    const failedOlder = run({ id: 'failed-older', status: 'failed', finishedAt: 2_000 })

    const { done, failed } = selectRecentlyFinished(
      snapshotOf([doneOlder, failedOlder, doneNewer, failedNewer]),
    )

    expect(done.map((r) => r.id)).toEqual(['done-newer', 'done-older'])
    expect(failed.map((r) => r.id)).toEqual(['failed-newer', 'failed-older'])
  })

  it('sorts a done/failed run with no timestamp to the back, not the front, of its bucket', () => {
    // A run in a finished status without `finishedAt` should never happen
    // through the schema (see model.ts's `.refine`), but the sort must still
    // handle it defensively: treating "unknown" as "most recent" would make
    // a data gap masquerade as the freshest result, which is exactly the
    // dishonesty this feature exists to remove.
    const timestamped = run({ id: 'done-timestamped', status: 'done', finishedAt: 1_000 })
    const missing = run({ id: 'done-missing-timestamp', status: 'done' })

    const { done } = selectRecentlyFinished(snapshotOf([missing, timestamped]))

    expect(done.map((r) => r.id)).toEqual(['done-timestamped', 'done-missing-timestamp'])
  })

  it('breaks ties (including two missing timestamps) by id, not input order', () => {
    const b = run({ id: 'b', status: 'done' })
    const a = run({ id: 'a', status: 'done' })

    const { done } = selectRecentlyFinished(snapshotOf([b, a]))

    expect(done.map((r) => r.id)).toEqual(['a', 'b'])
  })
})
