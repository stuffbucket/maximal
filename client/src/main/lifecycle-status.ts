import type { CoreStatus } from './core'
import type { LifecycleStatus } from '../shared/bridge-types'

/** Remove main-only connection details before lifecycle state crosses IPC. */
export function toLifecycleStatus(status: CoreStatus): LifecycleStatus {
  switch (status.phase) {
    case 'starting':
    case 'stopped':
      return { phase: status.phase }
    case 'boot-status':
      return { phase: status.phase, message: status.message }
    case 'ready':
      return {
        phase: status.phase,
        proxyUrl: status.proxyUrl,
        pid: status.pid,
      }
    case 'crashed':
      return {
        phase: status.phase,
        code: status.code,
        signal: status.signal,
        attempt: status.attempt,
        willRetry: status.willRetry,
      }
    case 'restarting':
      return {
        phase: status.phase,
        attempt: status.attempt,
        delayMs: status.delayMs,
      }
    case 'failed':
      return { phase: status.phase, reason: status.reason }
  }
}
