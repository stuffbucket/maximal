/**
 * The `providers` app service: the upstream providers plugins can use.
 * `providersService(initial)` builds it with the host-supplied providers
 * (Copilot), which live as long as the host; a plugin may register more
 * through `ctx.providers.register`, bound to its fiber. Install it with
 * `services.extra: [providersService([...])]`.
 */
import type { Context } from "@deepseek-ai/cordis"

import { Service } from "@deepseek-ai/cordis"

import type { ProviderRegistry, UpstreamProvider } from "../providers"
import type { PluginDisposer } from "../types"
import type { PluginServiceFactory } from "./services"
import type { PluginRuntime } from "./state"

import { PluginContractError } from "../errors"

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/

const kProviders = Symbol("maximal.plugin.providers")
const kRuntime = Symbol("maximal.plugin.providers.runtime")

const REQUIRED_METHODS = [
  "postJson",
  "model",
  "onCatalogChange",
  "available",
  "cost",
] as const

function check(owner: string, provider: UpstreamProvider): void {
  const fail = (message: string) =>
    new PluginContractError("invalid-provider", `${owner} ${message}`)
  if (typeof provider.id !== "string" || !PROVIDER_ID.test(provider.id)) {
    throw fail(`provider id must match ${PROVIDER_ID.source}.`)
  }
  if (typeof provider.displayName !== "string" || provider.displayName === "") {
    throw fail(`provider "${provider.id}" needs a displayName.`)
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof provider[method] !== "function") {
      throw fail(`provider "${provider.id}" needs a ${method}() function.`)
    }
  }
}

function add(
  providers: Map<string, UpstreamProvider>,
  owner: string,
  provider: UpstreamProvider,
): void {
  check(owner, provider)
  if (providers.has(provider.id)) {
    throw new PluginContractError(
      "duplicate-provider",
      `${owner} cannot register provider "${provider.id}": it is already registered.`,
    )
  }
  providers.set(provider.id, provider)
}

class ProvidersService extends Service implements ProviderRegistry {
  declare [kProviders]: Map<string, UpstreamProvider>;
  declare [kRuntime]: PluginRuntime

  constructor(
    ctx: Context,
    runtime: PluginRuntime,
    initial: ReadonlyArray<UpstreamProvider>,
  ) {
    super(ctx, "providers")
    this[kRuntime] = runtime
    this[kProviders] = new Map()
    for (const provider of initial) add(this[kProviders], "The host", provider)
  }

  register(provider: UpstreamProvider): PluginDisposer {
    const providers = this[kProviders]
    const slot = this[kRuntime].slotOf(this.ctx, "providers")
    add(providers, `Plugin "${slot.id}"`, provider)
    const withdraw = () => {
      if (providers.get(provider.id) === provider) providers.delete(provider.id)
    }
    let release: (() => unknown) | undefined
    try {
      release = this.ctx.effect(
        () => withdraw,
        `providers.register(${provider.id})`,
      )
    } catch (error) {
      withdraw()
      throw error
    }
    const releaseEffect = release
    return () => {
      withdraw()
      void Promise.resolve(releaseEffect()).catch(() => {})
    }
  }

  get(id: string): UpstreamProvider | undefined {
    return this[kProviders].get(id)
  }

  list(): ReadonlyArray<Pick<UpstreamProvider, "id" | "displayName">> {
    return [...this[kProviders].values()].map(({ id, displayName }) => ({
      id,
      displayName,
    }))
  }
}

/** `services.extra` factory for the `providers` service. */
export function providersService(
  initial: ReadonlyArray<UpstreamProvider> = [],
): PluginServiceFactory {
  return (root, runtime) => new ProvidersService(root, runtime, initial)
}
