import { AsyncLocalStorage } from "node:async_hooks"

import type { RequestContextWindow } from "~/lib/token-usage/request-meta"

/**
 * Per-request usage metadata, filled in as the request moves through
 * middleware and handlers and read back when its token usage is recorded.
 */
export interface RequestUsageMeta {
  apiKeyLabel?: string | null
  sessionId?: string
  model?: string
  cacheTtlS?: number
  cacheTtlRequested?: boolean
  isCompact?: boolean
  context?: RequestContextWindow
}

export interface RequestContext {
  traceId: string
  startTime: number
  userAgent: string
  sessionAffinity: string | undefined
  parentSessionId: string | undefined
  usage: RequestUsageMeta
}

const TRACE_ID_MAX_LENGTH = 64
const TRACE_ID_PATTERN = /^\w[\w.-]*$/

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>()

export const requestContext = {
  getStore: () => asyncLocalStorage.getStore(),
  run: <T>(context: RequestContext, callback: () => T) =>
    asyncLocalStorage.run(context, callback),
}

export function generateTraceId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 8)
  return `${timestamp}-${random}`
}

export function resolveTraceId(traceId: string | null | undefined): string {
  const candidate = traceId?.trim()

  if (
    !candidate
    || candidate.length > TRACE_ID_MAX_LENGTH
    || !TRACE_ID_PATTERN.test(candidate)
  ) {
    return generateTraceId()
  }

  return candidate
}
