import { describe, expect, it } from 'vitest'

import type { CoreStatus } from './core'
import { toLifecycleStatus } from './lifecycle-status'

describe('toLifecycleStatus', () => {
  it.each<CoreStatus>([
    { phase: 'starting' },
    { phase: 'boot-status', message: 'Checking configuration' },
    {
      phase: 'ready',
      controlOrigin: 'http://127.0.0.1:54321',
      proxyUrl: 'http://127.0.0.1:4141',
      pid: 42,
    },
    {
      phase: 'crashed',
      code: 1,
      signal: 'SIGTERM',
      attempt: 2,
      willRetry: true,
    },
    { phase: 'restarting', attempt: 2, delayMs: 2_000 },
    { phase: 'failed', reason: 'restart budget exhausted' },
    { phase: 'stopped' },
  ])('maps the $phase phase', (status) => {
    expect(toLifecycleStatus(status).phase).toBe(status.phase)
  })

  it('removes the private control origin from ready state', () => {
    const result = toLifecycleStatus({
      phase: 'ready',
      controlOrigin: 'http://127.0.0.1:54321',
      proxyUrl: 'http://127.0.0.1:4141',
      pid: 42,
    })

    expect(result).toEqual({
      phase: 'ready',
      proxyUrl: 'http://127.0.0.1:4141',
      pid: 42,
    })
    expect(result).not.toHaveProperty('controlOrigin')
  })

  it('copies every renderer-safe field for non-ready phases', () => {
    expect(
      toLifecycleStatus({
        phase: 'crashed',
        code: null,
        signal: 'SIGKILL',
        attempt: 5,
        willRetry: false,
      }),
    ).toEqual({
      phase: 'crashed',
      code: null,
      signal: 'SIGKILL',
      attempt: 5,
      willRetry: false,
    })
    expect(
      toLifecycleStatus({ phase: 'restarting', attempt: 3, delayMs: 5_000 }),
    ).toEqual({ phase: 'restarting', attempt: 3, delayMs: 5_000 })
    expect(
      toLifecycleStatus({ phase: 'boot-status', message: 'Starting proxy' }),
    ).toEqual({ phase: 'boot-status', message: 'Starting proxy' })
    expect(toLifecycleStatus({ phase: 'failed', reason: 'broken' })).toEqual({
      phase: 'failed',
      reason: 'broken',
    })
  })
})
