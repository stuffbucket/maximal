export type ContextManagementSupport = "supported" | "rejected"

export interface ObservedContextManagementCapability {
  account: string
  host: string
  model: string
  strategy: string
  support: "rejected"
  observedAt: string
}

const observations = new Map<string, ObservedContextManagementCapability>()

interface CapabilityScope {
  account: string
  host: string
  model: string
  strategy: string
}

function cacheKey(scope: CapabilityScope): string {
  return [scope.account, scope.host, scope.model, scope.strategy].join("\u0000")
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item))
  }
  if (typeof value !== "object" || value === null) return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeValue(item)]),
  )
}

export function contextManagementStrategy(
  contextManagement: unknown,
): string | null {
  if (
    typeof contextManagement !== "object"
    || contextManagement === null
    || Array.isArray(contextManagement)
  ) {
    return null
  }
  const edits = (contextManagement as { edits?: unknown }).edits
  if (!Array.isArray(edits)) return "unknown"
  if (edits.length === 0) return "empty-edits"

  const simpleTypes = edits.map((edit) => {
    if (typeof edit !== "object" || edit === null || Array.isArray(edit)) {
      return null
    }
    const entries = Object.entries(edit as Record<string, unknown>)
    const type = (edit as { type?: unknown }).type
    return entries.length === 1 && typeof type === "string" && type.length > 0 ?
        type
      : null
  })
  if (simpleTypes.every((type) => type !== null)) {
    return simpleTypes.sort().join(",")
  }

  return `configured:${JSON.stringify(normalizeValue(edits))}`
}

export function getObservedContextManagementSupport(
  scope: CapabilityScope,
): "rejected" | null {
  return observations.has(cacheKey(scope)) ? "rejected" : null
}

export function observeContextManagementSupport(
  scope: CapabilityScope,
  support: ContextManagementSupport,
  now: number = Date.now(),
): void {
  const key = cacheKey(scope)
  if (support === "supported") {
    observations.delete(key)
    return
  }
  observations.set(key, {
    ...scope,
    support,
    observedAt: new Date(now).toISOString(),
  })
}

export function listObservedContextManagementCapabilities(): Array<ObservedContextManagementCapability> {
  return [...observations.values()]
}
