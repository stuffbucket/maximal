/**
 * Plugin notices (`ctx.surface.notify`): one-off messages for the person
 * using Maximal, such as a connector that is working again after a sign-in,
 * or a sign-in that won't survive a restart. The menu-bar shell takes them
 * (POST /settings/api/notices/plugins) and shows each as a native
 * notification, worded by `code` when it knows the code. Without the shell
 * (the CLI, the Linux service) nothing takes them; the queue stays small.
 */

import type { PluginGatewayEvent } from "@stuffbucket/maximal-plugin-sdk/gateway"

/** A notice as the shell receives it. */
export interface PluginNoticeView {
  /** Plugin id. */
  plugin: string
  /** Plugin display name, for the notification's title. */
  name: string
  code: string
  /** English text, for codes the shell has no wording for. */
  message: string
  params: Record<string, string>
}

/** Older notices are dropped beyond this many (nothing is taking them). */
const MAX_QUEUED = 20

const queue: Array<PluginNoticeView> = []

/** Queue the notice a `notice` gateway event carries. */
export function queuePluginNotice(
  event: PluginGatewayEvent,
  displayName: string,
): void {
  if (event.type !== "notice" || !event.notice) return
  queue.push({
    plugin: event.pluginId,
    name: displayName,
    code: event.notice.code,
    message: event.notice.message,
    params: { ...event.notice.params },
  })
  if (queue.length > MAX_QUEUED) queue.splice(0, queue.length - MAX_QUEUED)
}

/** Hand over every queued notice, oldest first, and clear the queue. */
export function takePluginNotices(): Array<PluginNoticeView> {
  return queue.splice(0)
}
