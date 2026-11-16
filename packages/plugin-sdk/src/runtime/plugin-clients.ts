/** Cordis-backed, data-only plugin client contribution registry. */
import type { Context } from "@deepseek-ai/cordis"

import { Service } from "@deepseek-ai/cordis"

import type {
  PluginClientContribution,
  PluginClientId,
  PluginClientRegistry,
} from "../plugin-clients"
import type { PluginDisposer } from "../types"
import type { PluginServiceFactory } from "./services"
import type { PluginRuntime } from "./state"

import { PluginContractError } from "../errors"
import { PLUGIN_CLIENT_IDS } from "../gateway"

const DRIVER_ID = /^[a-z][a-z0-9-]{0,63}$/
const MAX_REASON_LENGTH = 500
const CLIENT_IDS = new Set<string>(PLUGIN_CLIENT_IDS)

const kEntries = Symbol("maximal.plugin.clients.entries")
const kRuntime = Symbol("maximal.plugin.clients.runtime")

interface RegistryEntry {
  readonly contribution: Readonly<PluginClientContribution>
  readonly owner: string
}

const registries = new WeakMap<Context, PluginClientRegistry>()

function normalize(
  owner: string,
  value: unknown,
): Readonly<PluginClientContribution> {
  const fail = (message: string): never => {
    throw new PluginContractError(
      "invalid-plugin-client",
      `${owner} ${message}`,
    )
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return fail("must register a plugin client object.")
  const input = value as Partial<
    Record<keyof PluginClientContribution, unknown>
  >
  if (typeof input.clientId !== "string" || !CLIENT_IDS.has(input.clientId))
    return fail("registered an unknown client id.")
  const clientId = input.clientId as PluginClientId
  if (
    input.driverId !== undefined
    && (typeof input.driverId !== "string" || !DRIVER_ID.test(input.driverId))
  )
    return fail(`client "${clientId}" has an invalid driver id.`)
  if (
    input.unavailableReason !== undefined
    && (typeof input.unavailableReason !== "string"
      || input.unavailableReason.trim() === ""
      || input.unavailableReason.length > MAX_REASON_LENGTH)
  )
    return fail(`client "${clientId}" has an invalid unavailable reason.`)
  return Object.freeze({
    clientId,
    ...(input.driverId === undefined ? {} : { driverId: input.driverId }),
    ...(input.unavailableReason === undefined ?
      {}
    : { unavailableReason: input.unavailableReason }),
  })
}

function add(
  entries: Map<string, RegistryEntry>,
  owner: string,
  value: PluginClientContribution,
): RegistryEntry {
  const contribution = normalize(owner, value)
  const existing = entries.get(contribution.clientId)
  if (existing) {
    throw new PluginContractError(
      "duplicate-plugin-client",
      `${owner} cannot register client "${contribution.clientId}": ${existing.owner} already registered it.`,
    )
  }
  const entry = { contribution, owner }
  entries.set(contribution.clientId, entry)
  return entry
}

class PluginClientsService extends Service implements PluginClientRegistry {
  declare [kEntries]: Map<string, RegistryEntry>;
  declare [kRuntime]: PluginRuntime

  constructor(
    ctx: Context,
    runtime: PluginRuntime,
    initial: ReadonlyArray<PluginClientContribution>,
  ) {
    super(ctx, "pluginClients")
    this[kRuntime] = runtime
    this[kEntries] = new Map()
    const normalized = initial.map((value) => normalize("The host", value))
    const ids = new Set<string>()
    for (const contribution of normalized) {
      if (ids.has(contribution.clientId)) {
        throw new PluginContractError(
          "duplicate-plugin-client",
          `The host lists client "${contribution.clientId}" more than once.`,
        )
      }
      ids.add(contribution.clientId)
    }
    for (const contribution of normalized)
      add(this[kEntries], "The host", contribution)
    registries.set(ctx, this)
  }

  register(contribution: PluginClientContribution): PluginDisposer {
    const runtime = this[kRuntime]
    const slot = runtime.slotOf(this.ctx, "pluginClients")
    const entries = this[kEntries]
    const entry = add(entries, `Plugin "${slot.id}"`, contribution)
    const withdraw = (): void => {
      if (entries.get(entry.contribution.clientId) !== entry) return
      entries.delete(entry.contribution.clientId)
      runtime.pluginClientsChanged(slot)
    }
    let release: (() => unknown) | undefined
    try {
      release = this.ctx.effect(
        () => withdraw,
        `pluginClients.register(${entry.contribution.clientId})`,
      )
    } catch (error) {
      entries.delete(entry.contribution.clientId)
      throw error
    }
    runtime.pluginClientsChanged(slot)
    const releaseEffect = release
    return () => {
      withdraw()
      void Promise.resolve(releaseEffect()).catch(() => {})
    }
  }

  list(): ReadonlyArray<PluginClientContribution> {
    return [...this[kEntries].values()].map(({ contribution }) => ({
      ...contribution,
    }))
  }
}

/** App service with a host-owned catalog plus fiber-bound plugin additions. */
export function pluginClientsService(
  initial: ReadonlyArray<PluginClientContribution> = [],
): PluginServiceFactory {
  return (root, runtime) => new PluginClientsService(root, runtime, initial)
}

/** Snapshot the registry installed on this host root. */
export function pluginClientContributionsOf(
  root: Context,
): Array<PluginClientContribution> {
  return [...(registries.get(root)?.list() ?? [])].map((value) => ({
    ...value,
  }))
}
