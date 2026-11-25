import type { UpstreamPool } from "./upstream/pool"

const activePools = new Set<UpstreamPool>()

/** Register one connector pool for generation-owned MCP session release. */
export function registerUpstreamPool(pool: UpstreamPool): () => void {
  activePools.add(pool)
  return () => activePools.delete(pool)
}

/**
 * Release a downstream session from every connector pool in this runner.
 * Session ids are globally unique on the parent MCP surface; pools that never
 * saw the id acknowledge it as already released.
 */
export async function releaseUpstreamSession(
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  await Promise.all(
    [...activePools].map((pool) => pool.releaseSession(sessionId, signal)),
  )
  signal.throwIfAborted()
}
