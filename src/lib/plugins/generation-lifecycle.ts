import type { JsonValue } from "@stuffbucket/maximal-plugin-protocol"

export const RELEASE_UPSTREAM_SESSION_METHOD =
  "mcp.release-upstream-session" as const

export interface GenerationReleaseTarget {
  dispatch(method: string, params: JsonValue): Promise<JsonValue>
}

type CutoverListener = (generationId: string, drainDeadline: number) => void

interface RegisteredTarget {
  readonly token: number
  readonly target: GenerationReleaseTarget
}

/** Production bridge from runner/cutover ownership into MCP affinity. */
export class PluginGenerationLifecycleRegistry {
  readonly #targets = new Map<string, Array<RegisteredTarget>>()
  readonly #listeners = new Set<CutoverListener>()
  #nextToken = 0

  registerGeneration(
    generationId: string,
    target: GenerationReleaseTarget,
  ): () => void {
    const registration = { token: ++this.#nextToken, target }
    const targets = this.#targets.get(generationId) ?? []
    targets.push(registration)
    this.#targets.set(generationId, targets)
    return () => {
      const current = this.#targets.get(generationId)
      if (!current) return
      const remaining = current.filter((entry) => entry !== registration)
      if (remaining.length === 0) this.#targets.delete(generationId)
      else this.#targets.set(generationId, remaining)
    }
  }

  async releaseUpstreamSession(
    generationId: string,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    const target = this.#targets.get(generationId)?.at(-1)?.target
    if (!target)
      throw new Error(`Plugin generation ${generationId} is unavailable.`)
    const operation = target.dispatch(RELEASE_UPSTREAM_SESSION_METHOD, {
      sessionId,
    })
    let rejectAbort!: (error: Error) => void
    const onAbort = (): void => {
      rejectAbort(new Error("MCP upstream release was aborted."))
    }
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject
      signal.addEventListener("abort", onAbort, { once: true })
    })
    try {
      await Promise.race([operation, aborted])
      signal.throwIfAborted()
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
  }

  subscribeCutovers(listener: CutoverListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  publishCutover(generationId: string, drainDeadline: number): void {
    for (const listener of this.#listeners) {
      listener(generationId, drainDeadline)
    }
  }
}

export const pluginGenerationLifecycle = new PluginGenerationLifecycleRegistry()
