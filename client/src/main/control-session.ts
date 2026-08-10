import { ControlClient, ControlRpcError } from '@stuffbucket/maximal-core/client'
import {
  CONTROL_ERROR_REASONS,
  type ControlErrorReason,
} from '@stuffbucket/maximal-core/control-contract'
import { SUPPORTED_PROTOCOL_VERSION } from '@stuffbucket/maximal-core/contract'
import {
  AccountsListResponse as AccountsListResponseSchema,
  type AccountsListResponse,
  AuthStatus as AuthStatusSchema,
  type AuthStatus,
} from '@stuffbucket/maximal-core/settings-types'
import { z } from 'zod'

import { awaitControlOrigin, onCoreStatus, type CoreStatus } from './core'
import type {
  ControlFailure,
  ControlResult,
} from '../shared/bridge-types'

type ControlMethod =
  | 'auth/status'
  | 'auth/start'
  | 'auth/cancel'
  | 'auth/signOut'
  | 'accounts/list'
  | 'accounts/switch'

interface ControlClientLike {
  call<T = unknown>(method: string, params?: unknown): Promise<T>
  onState(listener: () => void): () => void
  connect(): Promise<void>
  close(): void
}

interface LiveControlClient {
  origin: string
  client: ControlClientLike
  methods: ReadonlySet<string>
  stopState: () => void
  generation: number
}

interface ControlSessionDependencies {
  awaitOrigin(): Promise<string>
  onLifecycle(listener: (status: CoreStatus) => void): () => void
  createClient(origin: string): ControlClientLike
  onChange(): void
  logError(message: string, error: unknown): void
}

export interface ControlSession {
  authStatus(): Promise<ControlResult<AuthStatus>>
  authStart(): Promise<ControlResult<AuthStatus>>
  authCancel(): Promise<ControlResult<AuthStatus>>
  authSignOut(): Promise<ControlResult<null>>
  accountsList(): Promise<ControlResult<AccountsListResponse>>
  accountsSwitch(key: string): Promise<ControlResult<null>>
  dispose(): void
}

const requiredMethods = [
  'auth/status',
  'auth/start',
  'auth/signOut',
  'subscriptions/listen',
] as const

const optionalMethods = [
  'auth/cancel',
  'accounts/list',
  'accounts/switch',
] as const

const discoverySchema = z.object({
  protocolVersion: z.string(),
  capabilities: z.object({
    methods: z.array(z.string()),
    feed: z.literal(true),
  }),
  identity: z.object({
    name: z.literal('maximal-core'),
    version: z.string(),
  }),
})

const controlErrorDataSchema = z.object({
  reason: z.enum(CONTROL_ERROR_REASONS),
  retryable: z.boolean(),
  requestId: z.string().optional(),
  remediationUrl: z.string().optional(),
})

const accountsSwitchResultSchema = z.object({
  ok: z.literal(true),
  key: z.string(),
})

class SessionFailure extends Error {
  constructor(
    readonly reason: ControlFailure['reason'],
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'SessionFailure'
  }
}

function failureResult<T>(error: ControlFailure): ControlResult<T> {
  return { ok: false, error }
}

function mapFailure(error: unknown): ControlFailure {
  if (error instanceof SessionFailure) {
    return {
      reason: error.reason,
      message: error.message,
      retryable: error.retryable,
    }
  }

  if (error instanceof ControlRpcError) {
    const data = controlErrorDataSchema.safeParse(error.data)
    if (data.success) {
      return {
        reason: data.data.reason,
        message: error.message,
        retryable: data.data.retryable,
        code: error.code,
        ...(data.data.requestId === undefined
          ? {}
          : { requestId: data.data.requestId }),
        ...(data.data.remediationUrl === undefined
          ? {}
          : { remediationUrl: data.data.remediationUrl }),
      }
    }

    return {
      reason: 'internal',
      message: error.message,
      retryable: false,
      code: error.code,
    }
  }

  if (error instanceof z.ZodError) {
    return {
      reason: 'internal',
      message: error.message,
      retryable: false,
    }
  }

  return {
    reason: 'transport',
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  }
}

function unsupported(method: ControlMethod): ControlResult<never> {
  return failureResult({
    reason: 'unsupported',
    message: `maximal-core does not advertise ${method}`,
    retryable: false,
  })
}

export function createControlSession(
  options: Partial<ControlSessionDependencies> &
    Pick<ControlSessionDependencies, 'onChange'>,
): ControlSession {
  const dependencies: ControlSessionDependencies = {
    awaitOrigin: awaitControlOrigin,
    onLifecycle: onCoreStatus,
    createClient: (origin) => new ControlClient({ baseUrl: origin }),
    logError: (message, error) => console.error(message, error),
    ...options,
  }

  let live: LiveControlClient | null = null
  let generation = 0
  let disposed = false
  let replacementQueue: Promise<void> = Promise.resolve()

  async function buildClient(origin: string): Promise<LiveControlClient> {
    const discoveryClient = dependencies.createClient(origin)
    let discovery: z.infer<typeof discoverySchema>
    try {
      discovery = discoverySchema.parse(
        await discoveryClient.call('server/discover'),
      )
    } catch (error) {
      if (error instanceof ControlRpcError) throw error
      if (error instanceof z.ZodError) {
        throw new SessionFailure(
          'unsupported_version',
          `Incompatible maximal-core discovery response: ${error.message}`,
        )
      }
      throw error
    } finally {
      discoveryClient.close()
    }

    if (discovery.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
      throw new SessionFailure(
        'unsupported_version',
        `Unsupported maximal-core control protocol ${discovery.protocolVersion}; expected ${SUPPORTED_PROTOCOL_VERSION}`,
      )
    }

    const methods = new Set(discovery.capabilities.methods)
    const missing = requiredMethods.filter((method) => !methods.has(method))
    if (missing.length > 0) {
      throw new SessionFailure(
        'unsupported_version',
        `maximal-core is missing required control capabilities: ${missing.join(', ')}`,
      )
    }

    const client = dependencies.createClient(origin)
    const nextGeneration = generation + 1
    let initialState = true
    const stopState = client.onState(() => {
      if (initialState) {
        initialState = false
        return
      }
      if (!disposed && generation === nextGeneration) dependencies.onChange()
    })

    return {
      origin,
      client,
      methods,
      stopState,
      generation: nextGeneration,
    }
  }

  function replace(origin: string): Promise<void> {
    const queued = replacementQueue.then(async () => {
      if (disposed || live?.origin === origin) return

      const next = await buildClient(origin)
      if (disposed) {
        next.stopState()
        next.client.close()
        return
      }

      const stale = live
      generation = next.generation
      live = next
      stale?.stopState()
      stale?.client.close()

      void next.client.connect().catch((error: unknown) => {
        if (!disposed && generation === next.generation) {
          dependencies.logError(
            '[maximal-client] control stream stopped:',
            error,
          )
        }
      })
      dependencies.onChange()
    })

    replacementQueue = queued.catch(() => {})
    return queued
  }

  async function current(): Promise<LiveControlClient> {
    const origin = await dependencies.awaitOrigin()
    await replace(origin)
    if (!live || live.origin !== origin) {
      throw new SessionFailure(
        'transport',
        'maximal-core control connection is not available',
        true,
      )
    }
    return live
  }

  async function call<T>(
    method: ControlMethod,
    parse: (input: unknown) => T,
    params?: unknown,
  ): Promise<ControlResult<T>> {
    try {
      const active = await current()
      if (
        optionalMethods.includes(
          method as (typeof optionalMethods)[number],
        ) &&
        !active.methods.has(method)
      ) {
        return unsupported(method)
      }
      return {
        ok: true,
        value: parse(await active.client.call(method, params)),
      }
    } catch (error) {
      return failureResult(mapFailure(error))
    }
  }

  const stopLifecycle = dependencies.onLifecycle((status) => {
    if (status.phase !== 'ready') return
    void replace(status.controlOrigin).catch((error: unknown) => {
      if (!disposed) {
        dependencies.logError(
          '[maximal-client] control discovery failed:',
          error,
        )
      }
    })
  })

  return {
    authStatus: () => call('auth/status', AuthStatusSchema.parse),
    authStart: () => call('auth/start', AuthStatusSchema.parse),
    authCancel: () => call('auth/cancel', AuthStatusSchema.parse),
    authSignOut: () =>
      call('auth/signOut', () => null),
    accountsList: () =>
      call('accounts/list', AccountsListResponseSchema.parse),
    accountsSwitch: (key) =>
      call('accounts/switch', (input) => {
        accountsSwitchResultSchema.parse(input)
        return null
      }, { key }),
    dispose() {
      if (disposed) return
      disposed = true
      generation += 1
      stopLifecycle()
      live?.stopState()
      live?.client.close()
      live = null
    },
  }
}

export type { AuthStatus, AccountsListResponse, ControlErrorReason }
