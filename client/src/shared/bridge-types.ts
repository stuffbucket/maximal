import type { ControlErrorReason } from '@stuffbucket/maximal-core/control-contract'

/** Sidecar lifecycle state that is safe to expose to the product renderer. */
export type LifecycleStatus =
  | { phase: 'starting' }
  | { phase: 'boot-status'; message: string }
  | { phase: 'ready'; proxyUrl: string; pid: number }
  | {
      phase: 'crashed'
      code: number | null
      signal: string | null
      attempt: number
      willRetry: boolean
    }
  | { phase: 'restarting'; attempt: number; delayMs: number }
  | { phase: 'failed'; reason: string }
  | { phase: 'stopped' }

export type ControlFailureReason =
  | ControlErrorReason
  | 'transport'
  | 'unsupported'

/** Serializable control failure; Electron does not preserve custom Error fields. */
export interface ControlFailure {
  reason: ControlFailureReason
  message: string
  retryable: boolean
  requestId?: string
  remediationUrl?: string
  code?: number
}

export type ControlResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ControlFailure }
