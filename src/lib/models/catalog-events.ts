import consola from "consola"

const listeners = new Set<() => void>()

export function subscribeModelCatalogChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publishModelCatalogChanged(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      consola.warn("model catalog listener failed", error)
    }
  }
}
