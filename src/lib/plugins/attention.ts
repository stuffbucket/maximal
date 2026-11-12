/**
 * Plugins that need the person now: each enabled, running plugin whose
 * status carries `attention` (a FigJam panel waiting for approval, say). The
 * menu-bar shell polls this to light its attention icon and to list the
 * actions in the tray menu; the actions run through
 * `POST /settings/api/plugins/:id/actions/:actionId`.
 */

import type { PluginGateway } from "@stuffbucket/maximal-plugin-sdk/gateway"

import type { PluginAttentionItem } from "~/lib/config/settings-types"

/** What each enabled plugin currently asks for, in plugin order. */
export function pluginAttention(
  gateway: PluginGateway,
): Array<PluginAttentionItem> {
  const items: Array<PluginAttentionItem> = []
  for (const snapshot of gateway.list()) {
    // A plugin that is off or failed keeps no live status worth acting on.
    if (!snapshot.enabled || snapshot.lifecycle !== "active") continue
    const attention = snapshot.status?.attention
    if (!attention) continue
    items.push({
      plugin: snapshot.id,
      name: snapshot.displayName,
      summary: attention.summary,
      actions: attention.actions.map((action) => ({ ...action })),
    })
  }
  return items
}
