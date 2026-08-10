import type {
  ControlFailure,
  ControlResult,
} from '../../shared/bridge-types'

/** Renderer-local Error reconstructed from the bridge's serializable failure. */
export class ControlCallError extends Error {
  readonly reason: ControlFailure['reason']
  readonly retryable: boolean
  readonly requestId?: string
  readonly remediationUrl?: string
  readonly code?: number

  constructor(failure: ControlFailure) {
    super(failure.message)
    this.name = 'ControlCallError'
    this.reason = failure.reason
    this.retryable = failure.retryable
    this.requestId = failure.requestId
    this.remediationUrl = failure.remediationUrl
    this.code = failure.code
  }
}

export function unwrapControlResult<T>(result: ControlResult<T>): T {
  if (result.ok) return result.value
  throw new ControlCallError(result.error)
}
