import type { Context, Fiber } from "@deepseek-ai/cordis"

import type {
  PluginActionHandler,
  PluginDisposer,
  PluginStatus,
  ToolDefinition,
} from "../types"

import { PluginContractError } from "../errors"

export type PluginRuntimeEventType = "status" | "tools"

export interface PluginRuntimeEvent {
  type: PluginRuntimeEventType
  pluginId: string
}

/** One `ctx.effect`-bound contribution (a tool set or an action). */
interface Registration {
  active: boolean
  /** Releases the backing cordis effect (no-op once released). */
  releaseEffect: () => void
}

interface ToolEntry {
  definition: Readonly<ToolDefinition>
  owner: Registration
}

interface ActionEntry {
  handler: PluginActionHandler
  owner: Registration
}

/** Live contributions of one plugin activation (one fiber). */
export class PluginSlot {
  readonly id: string
  readonly fiber: Fiber
  readonly tools = new Map<string, ToolEntry>()
  readonly actions = new Map<string, ActionEntry>()
  readonly registrations = new Set<Registration>()
  status: Readonly<PluginStatus> | undefined
  attached = true

  constructor(id: string, fiber: Fiber) {
    this.id = id
    this.fiber = fiber
  }
}

export interface PluginRuntimeOptions {
  onChange?: (event: PluginRuntimeEvent) => void
}

/**
 * Host-side state behind the `tools` / `surface` services: which fiber
 * belongs to which plugin id, and what each activation contributed.
 * Plain object (no cordis `Service`), so `#private` fields are safe here.
 */
export class PluginRuntime {
  readonly #owners = new WeakMap<Fiber, PluginSlot>()
  readonly #slots = new Map<string, PluginSlot>()
  readonly #onChange: ((event: PluginRuntimeEvent) => void) | undefined

  constructor(options: PluginRuntimeOptions = {}) {
    this.#onChange = options.onChange
  }

  /** Bind a freshly created plugin fiber to its plugin id. */
  attach(pluginId: string, handle: Fiber): PluginSlot {
    if (this.#slots.has(pluginId)) {
      throw new Error(
        `Plugin "${pluginId}" is already attached; release it first.`,
      )
    }
    // `ctx.plugin()` returns a thenable wrapper whose prototype is the fiber;
    // the plugin's own context points at the real one.
    const fiber = handle.ctx.fiber
    const slot = new PluginSlot(pluginId, fiber)
    this.#slots.set(pluginId, slot)
    this.#owners.set(fiber, slot)
    return slot
  }

  /**
   * Drop everything an activation contributed (normally already withdrawn by
   * fiber disposal) and detach it. Late calls from the old fiber are ignored.
   */
  release(pluginId: string): void {
    const slot = this.#slots.get(pluginId)
    if (!slot) return
    this.#slots.delete(pluginId)
    slot.attached = false
    for (const registration of slot.registrations) retire(registration)
    slot.registrations.clear()
    slot.actions.clear()
    const hadTools = slot.tools.size > 0
    const hadStatus = slot.status !== undefined
    slot.tools.clear()
    slot.status = undefined
    if (hadTools) this.#notify({ type: "tools", pluginId })
    if (hadStatus) this.#notify({ type: "status", pluginId })
  }

  /** Resolve the plugin activation that owns `ctx` (walking up sub-plugin fibers). */
  slotOf(ctx: Context, service: string): PluginSlot {
    const seen = new Set<Fiber>()
    let { fiber } = ctx
    // The root fiber is its own parent, so the `seen` check ends the walk.
    while (!seen.has(fiber)) {
      seen.add(fiber)
      const slot = this.#owners.get(fiber)
      if (slot) return slot
      fiber = fiber.parent.fiber
    }
    throw new PluginContractError(
      "not-a-plugin",
      `ctx.${service} is only available to plugins loaded by the maximal plugin host.`,
    )
  }

  isAttached(pluginId: string): boolean {
    return this.#slots.has(pluginId)
  }

  tools(pluginId: string): Array<Readonly<ToolDefinition>> {
    const slot = this.#slots.get(pluginId)
    return slot ? [...slot.tools.values()].map((entry) => entry.definition) : []
  }

  tool(pluginId: string, name: string): Readonly<ToolDefinition> | undefined {
    return this.#slots.get(pluginId)?.tools.get(name)?.definition
  }

  status(pluginId: string): Readonly<PluginStatus> | undefined {
    return this.#slots.get(pluginId)?.status
  }

  action(pluginId: string, actionId: string): PluginActionHandler | undefined {
    return this.#slots.get(pluginId)?.actions.get(actionId)?.handler
  }

  actionIds(pluginId: string): Array<string> {
    const slot = this.#slots.get(pluginId)
    return slot ? [...slot.actions.keys()] : []
  }

  /**
   * Run `install` inside `ctx.effect` on the caller's fiber so the
   * contribution is withdrawn when that fiber unloads (dsh-llm
   * `registerAdapter` pattern). Returns an idempotent sync disposer.
   */
  // eslint-disable-next-line max-params -- internal runtime API; slot/ctx/label/install are all required and positional
  bind(
    slot: PluginSlot,
    ctx: Context,
    label: string,
    install: (registration: Registration) => void,
  ): {
    registration: Registration
    dispose: PluginDisposer
  } {
    const registration: Registration = { active: true, releaseEffect: () => {} }
    const disposeEffect = ctx.effect(() => {
      install(registration)
      slot.registrations.add(registration)
      return () => this.#withdraw(slot, registration)
    }, label)
    let released = false
    registration.releaseEffect = () => {
      if (released) return
      released = true
      void Promise.resolve(disposeEffect()).catch(() => {})
    }
    const dispose: PluginDisposer = () => {
      this.#withdraw(slot, registration)
      registration.releaseEffect()
    }
    return { registration, dispose }
  }

  /** Replace the slot's entire tool set with `definitions`, owned by `registration`. */
  replaceTools(
    slot: PluginSlot,
    definitions: ReadonlyArray<Readonly<ToolDefinition>>,
    registration: Registration,
  ): void {
    slot.tools.clear()
    for (const definition of definitions)
      slot.tools.set(definition.name, { definition, owner: registration })
    this.#emit(slot, "tools")
  }

  addTool(
    slot: PluginSlot,
    definition: Readonly<ToolDefinition>,
    registration: Registration,
  ): void {
    if (slot.tools.has(definition.name)) {
      throw new PluginContractError(
        "duplicate-tool",
        `Plugin "${slot.id}" already registered tool "${definition.name}".`,
        {
          pluginId: slot.id,
        },
      )
    }
    slot.tools.set(definition.name, { definition, owner: registration })
    this.#emit(slot, "tools")
  }

  // eslint-disable-next-line max-params -- internal runtime API; slot/id/handler/registration are all required and positional
  addAction(
    slot: PluginSlot,
    id: string,
    handler: PluginActionHandler,
    registration: Registration,
  ): void {
    if (slot.actions.has(id)) {
      throw new PluginContractError(
        "duplicate-action",
        `Plugin "${slot.id}" already registered action "${id}".`,
        {
          pluginId: slot.id,
        },
      )
    }
    slot.actions.set(id, { handler, owner: registration })
  }

  /**
   * Release the cordis effects of registrations whose tools were superseded
   * by `registerAll` (their contributions are already gone), so repeated
   * refreshes don't accumulate effects on the fiber.
   */
  retireRegistrations(
    slot: PluginSlot,
    registrations: ReadonlySet<Registration>,
    keep: Registration,
  ): void {
    for (const registration of registrations) {
      if (registration === keep || !slot.registrations.has(registration))
        continue
      slot.registrations.delete(registration)
      retire(registration)
    }
  }

  setStatus(slot: PluginSlot, status: Readonly<PluginStatus>): void {
    if (!slot.attached) return
    if (
      slot.status !== undefined
      && JSON.stringify(slot.status) === JSON.stringify(status)
    )
      return
    slot.status = status
    this.#emit(slot, "status")
  }

  #withdraw(slot: PluginSlot, registration: Registration): void {
    if (!registration.active) return
    registration.active = false
    slot.registrations.delete(registration)
    let toolsChanged = false
    for (const [name, entry] of slot.tools) {
      if (entry.owner !== registration) continue
      slot.tools.delete(name)
      toolsChanged = true
    }
    for (const [id, entry] of slot.actions) {
      if (entry.owner === registration) slot.actions.delete(id)
    }
    if (toolsChanged) this.#emit(slot, "tools")
  }

  #emit(slot: PluginSlot, type: PluginRuntimeEventType): void {
    if (this.#slots.get(slot.id) !== slot) return
    this.#notify({ type, pluginId: slot.id })
  }

  #notify(event: PluginRuntimeEvent): void {
    try {
      this.#onChange?.(event)
    } catch {
      // Observer failures never break plugin registration.
    }
  }
}

function retire(registration: Registration): void {
  registration.active = false
  registration.releaseEffect()
}
