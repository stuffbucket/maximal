type PluginAccessListener = (pluginId: string) => void

const listeners = new Set<PluginAccessListener>()

export function subscribePluginAccessChanges(
  listener: PluginAccessListener,
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function notifyPluginAccessChanged(pluginId: string): void {
  for (const listener of listeners) listener(pluginId)
}
