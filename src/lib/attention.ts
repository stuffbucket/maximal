/**
 * Core attention sources: things the app itself needs the person to look at,
 * listed beside the plugins' own (`GET /settings/api/plugins/attention`).
 * The menu-bar shell shows every item the same way, and runs an action
 * through `POST /settings/api/plugins/:source/actions/:actionId`, which a
 * source answers before the plugin gateway is asked.
 */

import type { PluginAttentionItem } from "~/lib/config/settings-types"

export interface CoreAttentionSource {
  /** What the shell calls the item's `plugin`; a plugin can't use it. */
  id: string
  items(): Array<PluginAttentionItem>
  /** Run an action; false when it names nothing (it was already taken, or
   *  the thing it was about is gone). */
  run(actionId: string): boolean
}

const sources = new Map<string, CoreAttentionSource>()

/** Add (or replace) a source. Returns a function that removes it. */
export function registerCoreAttentionSource(
  source: CoreAttentionSource,
): () => void {
  sources.set(source.id, source)
  return () => {
    if (sources.get(source.id) === source) sources.delete(source.id)
  }
}

/** Every item the core currently asks for, in the order sources registered. */
export function coreAttention(): Array<PluginAttentionItem> {
  return [...sources.values()].flatMap((source) => source.items())
}

/** Run an action of a core source: undefined when `sourceId` isn't one,
 *  else whether the action named something. */
export function runCoreAttentionAction(
  sourceId: string,
  actionId: string,
): boolean | undefined {
  return sources.get(sourceId)?.run(actionId)
}
