/**
 * Generation activation for trusted plugins.
 *
 * Most plugins are overlap-safe: an old and candidate generation may be alive
 * together. A plugin that owns a singleton names every exclusive resource and
 * defers acquisition until `commit`. Hooks must be idempotent and honor the
 * supplied abort signal; the host serializes calls but cannot roll back direct
 * process, filesystem, or network side effects made by plugin code.
 */

/** A stable, process-independent singleton name (for example `figjam-bridge:4150`). */
export const PLUGIN_RESOURCE_PATTERN =
  /^[a-z][a-z0-9._-]{0,63}(?::[a-z0-9._-]{1,63})+$/

export type PluginResourceDeclaration =
  | { mode: "overlap-safe" }
  | { mode: "exclusive"; resources: ReadonlyArray<string> }

/** One bounded lifecycle invocation. `deadline` is an epoch millisecond. */
export interface PluginLifecycleContext {
  readonly signal: AbortSignal
  readonly deadline: number
  /** Startup may remain available with an error status; handoff must prove readiness. */
  readonly purpose: "activation" | "handoff" | "recovery"
}

export interface PluginLifecycleCallOptions {
  signal?: AbortSignal
  /** Absolute epoch millisecond. Defaults are chosen by the host. */
  deadline?: number
  purpose?: "activation" | "handoff" | "recovery"
}

/**
 * Returned by `PluginModule.apply` when activation owns lifecycle-sensitive
 * resources. `prepare` must not acquire an exclusive resource. Handoff and
 * recovery `commit` calls must resolve only after the resource is bound and
 * ready. Initial activation may instead retain the logical reservation while
 * exposing an explicit recoverable error and retry action. `revoke` relinquishes
 * the resource; `resume` recreates the previous instance after a failed handoff.
 */
export interface PluginResourceLifecycle {
  readonly declaration: PluginResourceDeclaration
  prepare(context: PluginLifecycleContext): void | Promise<void>
  commit(context: PluginLifecycleContext): void | Promise<void>
  revoke(context: PluginLifecycleContext): void | Promise<void>
  resume(context: PluginLifecycleContext): void | Promise<void>
}

export type PluginApplyResult = PluginResourceLifecycle | undefined

export type PluginResourcePhase =
  | "new"
  | "preparing"
  | "prepared"
  | "committing"
  | "committed"
  | "revoking"
  | "revoked"
  | "resuming"

export interface PluginResourceView {
  pluginId: string
  declaration: PluginResourceDeclaration
  phase: PluginResourcePhase
}

/** Narrow generation-facing surface used by a supervisor during cutover. */
export interface PluginGenerationResourceLifecycle {
  list(): Array<PluginResourceView>
  prepare(options?: PluginLifecycleCallOptions): Promise<void>
  commit(options?: PluginLifecycleCallOptions): Promise<void>
  revoke(options?: PluginLifecycleCallOptions): Promise<void>
  resume(options?: PluginLifecycleCallOptions): Promise<void>
}

export class PluginLifecycleTimeoutError extends Error {
  readonly deadline: number

  constructor(deadline: number) {
    super("Plugin lifecycle deadline expired.")
    this.name = "PluginLifecycleTimeoutError"
    this.deadline = deadline
  }
}

/**
 * Parent-owned declaration lease table. It is intentionally tiny: the future
 * process supervisor can implement the same acquire/release seam over IPC.
 */
export class ExclusiveResourceLeaseRegistry {
  readonly #owners = new Map<string, string>()

  acquire(owner: string, resources: ReadonlyArray<string>): void {
    const unique = [...new Set(resources)]
    for (const resource of unique) {
      const current = this.#owners.get(resource)
      if (current !== undefined && current !== owner) {
        throw new Error(
          `Exclusive resource "${resource}" is already leased by ${current}.`,
        )
      }
    }
    for (const resource of unique) this.#owners.set(resource, owner)
  }

  release(owner: string, resources?: ReadonlyArray<string>): void {
    const selected = resources ?? [...this.#owners.keys()]
    for (const resource of selected) {
      if (this.#owners.get(resource) === owner) this.#owners.delete(resource)
    }
  }

  releaseGeneration(generationId: string): void {
    for (const [resource, owner] of this.#owners) {
      if (owner.startsWith(`${generationId}/`)) this.#owners.delete(resource)
    }
  }

  owner(resource: string): string | undefined {
    return this.#owners.get(resource)
  }

  snapshot(): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries(this.#owners))
  }
}

export function isPluginResourceLifecycle(
  value: unknown,
): value is PluginResourceLifecycle {
  if (value === null || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  return (
    item.declaration !== undefined
    && typeof item.prepare === "function"
    && typeof item.commit === "function"
    && typeof item.revoke === "function"
    && typeof item.resume === "function"
  )
}

const isUnknownArray = (value: unknown): value is Array<unknown> =>
  Array.isArray(value)

export function normalizeResourceDeclaration(
  pluginId: string,
  declaration: unknown,
): PluginResourceDeclaration {
  if (declaration === null || typeof declaration !== "object") {
    throw new TypeError(
      `Plugin "${pluginId}" has an invalid resource declaration.`,
    )
  }
  const mode: unknown = Reflect.get(declaration, "mode")
  if (mode === "overlap-safe") return { mode: "overlap-safe" }
  const rawResources: unknown = Reflect.get(declaration, "resources")
  if (mode !== "exclusive" || !isUnknownArray(rawResources)) {
    throw new TypeError(
      `Plugin "${pluginId}" has an invalid resource declaration.`,
    )
  }
  const resources: Array<unknown> = [...rawResources]
  if (
    resources.length === 0
    || new Set(resources).size !== resources.length
    || resources.some(
      (resource) =>
        typeof resource !== "string" || !PLUGIN_RESOURCE_PATTERN.test(resource),
    )
  ) {
    throw new TypeError(
      `Plugin "${pluginId}" must declare unique exclusive resource names matching ${String(PLUGIN_RESOURCE_PATTERN)}.`,
    )
  }
  const names = resources.filter(
    (resource): resource is string => typeof resource === "string",
  )
  return Object.freeze({
    mode: "exclusive",
    resources: Object.freeze(names),
  })
}

/** Run one hook with a combined caller/deadline signal. */
export async function runPluginLifecycleHook(
  hook: (context: PluginLifecycleContext) => void | Promise<void>,
  options: PluginLifecycleCallOptions = {},
  defaultTimeoutMs = 10_000,
): Promise<void> {
  const deadline = options.deadline ?? Date.now() + defaultTimeoutMs
  const deadlineController = new AbortController()
  const remaining = deadline - Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  if (remaining <= 0) {
    deadlineController.abort(new PluginLifecycleTimeoutError(deadline))
  } else {
    timer = setTimeout(
      () => deadlineController.abort(new PluginLifecycleTimeoutError(deadline)),
      remaining,
    )
  }
  const signal =
    options.signal === undefined ?
      deadlineController.signal
    : AbortSignal.any([options.signal, deadlineController.signal])
  try {
    signal.throwIfAborted()
    // Hooks receive a deadline signal but own acknowledgment. In particular,
    // revoke must not reject before the physical resource is actually gone.
    await hook({ signal, deadline, purpose: options.purpose ?? "activation" })
    // A hook can finish concurrently with cancellation. Never acknowledge a
    // transition (especially a successful bind) after its absolute boundary.
    signal.throwIfAborted()
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
