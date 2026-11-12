/**
 * A scriptable upstream provider for capability-plugin tests: records every
 * `postJson`, answers from a queue (or one fixed reply), and lets the test
 * change the catalog and the sign-in state. `capabilityServices(fake)` is the
 * `extraServices` list (operations + providers) a capability plugin needs.
 */
import type {
  ProviderModelInfo,
  UpstreamProvider,
} from "@stuffbucket/maximal-plugin-sdk"

import {
  operationsService,
  type PluginServiceFactory,
  providersService,
} from "@stuffbucket/maximal-plugin-sdk/runtime"

export interface FakeUpstreamCall {
  path: string
  body: Record<string, unknown> | FormData
  options: { signal?: AbortSignal; errorMessage: string }
}

export interface FakeUpstreamOptions {
  /** Provider id (default `copilot`). */
  id?: string
  /** Catalog entries (default none). */
  models?: ReadonlyArray<ProviderModelInfo>
  /** The reply every call gets unless one is queued (default `{}`). */
  reply?: Record<string, unknown>
  /** Cost the provider reports for a reply (default none). */
  cost?: (reply: Record<string, unknown>) => number | undefined
}

export interface FakeUpstream {
  readonly provider: UpstreamProvider
  readonly calls: Array<FakeUpstreamCall>
  /** Queue replies (or errors to throw) for the next calls. */
  enqueue(...replies: Array<Record<string, unknown> | Error>): void
  /** Replace the catalog and notify listeners. */
  setModels(models: ReadonlyArray<ProviderModelInfo>): void
  /** Signed in or not (no notification: the catalog event follows). */
  setAvailable(available: boolean): void
  /** Catalog listeners still subscribed (a leak signal). */
  readonly listenerCount: number
}

export const catalogModel = (
  id: string,
  type = "decisions",
): ProviderModelInfo => ({ id, type, endpoints: [], preview: false })

export function createFakeUpstream(
  options: FakeUpstreamOptions = {},
): FakeUpstream {
  const calls: Array<FakeUpstreamCall> = []
  const queue: Array<Record<string, unknown> | Error> = []
  const listeners = new Set<() => void>()
  let models = options.models ?? []
  let available = true
  const provider: UpstreamProvider = {
    id: options.id ?? "copilot",
    displayName: "Fake provider",
    postJson: <T>(
      path: string,
      body: Record<string, unknown> | FormData,
      callOptions: { signal?: AbortSignal; errorMessage: string },
    ): Promise<T> => {
      calls.push({ path, body, options: callOptions })
      const next = queue.shift() ?? options.reply ?? {}
      return next instanceof Error ?
          Promise.reject(next)
        : Promise.resolve(next as T)
    },
    model: (id) => models.find((model) => model.id === id),
    onCatalogChange: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    available: () => available,
    cost: (reply) => {
      const amount = options.cost?.(reply)
      return amount === undefined ? undefined : (
          { unit: "nano_aiu", amount, estimated: false }
        )
    },
  }
  return {
    provider,
    calls,
    enqueue: (...replies) => {
      queue.push(...replies)
    },
    setModels: (next) => {
      models = next
      for (const listener of listeners) listener()
    },
    setAvailable: (next) => {
      available = next
    },
    get listenerCount() {
      return listeners.size
    },
  }
}

/** `extraServices` for a harness whose plugins serve operations through `fake`. */
export function capabilityServices(
  fake: FakeUpstream,
): ReadonlyArray<PluginServiceFactory> {
  return [operationsService, providersService([fake.provider])]
}
