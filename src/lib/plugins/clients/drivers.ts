/** Parent-owned trusted writers behind data-only plugin client contributions. */
import type { PluginClientContribution } from "@stuffbucket/maximal-plugin-sdk/gateway"

import type { PluginClientConfigurator } from "./sync"

import { claudeCodePluginClient } from "./claude-code"
import { claudeDesktopPluginClient } from "./claude-desktop"

const DRIVERS: ReadonlyMap<string, PluginClientConfigurator> = new Map([
  ["claude-code", claudeCodePluginClient],
  ["claude-desktop", claudeDesktopPluginClient],
])

/** Resolve only a known parent-owned writer; unknown child ids stay inert. */
export function pluginClientDriver(
  contribution: PluginClientContribution,
): PluginClientConfigurator | undefined {
  return contribution.driverId === undefined ?
      undefined
    : DRIVERS.get(contribution.driverId)
}
