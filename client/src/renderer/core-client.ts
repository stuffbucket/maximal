import { ControlClient } from '@stuffbucket/maximal-core/client'
import { CONTROL_PROTOCOL_VERSION } from '@stuffbucket/maximal-core/contract'
import {
  AuthStatus as AuthStatusSchema,
  type AuthStatus as AuthStatusType,
} from '@stuffbucket/maximal-core/settings-types'
import { z } from 'zod'

export type AuthStatus = AuthStatusType

export interface CoreClient {
  authStatus(): Promise<AuthStatus>
  authStart(): Promise<AuthStatus>
  signOut(): Promise<void>
  /** Subscribe to v2 control notifications. Returns an unsubscribe function. */
  subscribe(onEvent: () => void): () => void
}

const requiredMethods = ['auth/status', 'auth/start', 'auth/signOut', 'subscriptions/listen'] as const
const discoverySchema = z.object({
  protocolVersion: z.string(),
  capabilities: z.object({
    methods: z.array(z.string()),
    feed: z.boolean(),
  }),
  identity: z.object({
    name: z.literal('maximal-core'),
    version: z.string(),
  }),
})

export function createCoreClient(origin: string): CoreClient {
  const clientPromise = discover()

  async function discover(): Promise<ControlClient> {
    // Discovery is the one request that intentionally carries no version header:
    // it learns the stateless protocol version and effective method set.
    const discoveryClient = new ControlClient({ baseUrl: origin })
    const discovery = discoverySchema.parse(await discoveryClient.call('server/discover'))
    discoveryClient.close()

    const expected = String(CONTROL_PROTOCOL_VERSION)
    if (discovery.protocolVersion !== expected) {
      throw new Error(`Unsupported maximal-core control protocol ${discovery.protocolVersion}; expected ${expected}`)
    }
    const missing = requiredMethods.filter((method) => !discovery.capabilities.methods.includes(method))
    if (!discovery.capabilities.feed || missing.length > 0) {
      throw new Error(`maximal-core is missing required control capabilities: ${missing.join(', ') || 'feed'}`)
    }

    return new ControlClient({
      baseUrl: origin,
      headers: { 'mcp-protocol-version': discovery.protocolVersion },
    })
  }

  async function callAuth(method: 'auth/status' | 'auth/start'): Promise<AuthStatus> {
    const client = await clientPromise
    return AuthStatusSchema.parse(await client.call(method))
  }

  return {
    authStatus: () => callAuth('auth/status'),
    authStart: () => callAuth('auth/start'),
    signOut: async () => {
      const client = await clientPromise
      await client.call('auth/signOut')
    },
    subscribe(onEvent) {
      let closed = false
      let stopListening = () => {}
      let streamClient: ControlClient | null = null

      void clientPromise
        .then((client) => {
          if (closed) return
          streamClient = client
          stopListening = client.onState(() => onEvent())
          void client.connect().catch((error: unknown) => {
            if (!closed) console.error('[maximal-client] control stream stopped:', error)
          })
        })
        .catch((error: unknown) => {
          if (!closed) console.error('[maximal-client] control discovery failed:', error)
        })

      return () => {
        closed = true
        stopListening()
        streamClient?.close()
      }
    },
  }
}
