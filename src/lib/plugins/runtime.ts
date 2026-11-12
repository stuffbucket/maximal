/**
 * Plugin lifecycle inside the serving process: boot, settings changes,
 * client sync, Settings events, shutdown.
 */

import type { PluginGateway } from "@stuffbucket/maximal-plugin-sdk/gateway"

import consola from "consola"

import { getConfig } from "~/lib/config/config"
import { settingsEventBus } from "~/lib/config/settings-events"

import { removeLegacyClaudeDesktopEntries } from "./clients/claude-desktop-cleanup"
import { syncPluginClient } from "./clients/sync"
import { composePluginGateway, reloadComposedPluginInventory } from "./compose"
import { getPluginGateway, setPluginGateway } from "./gateway"
import { queuePluginNotice, takePluginNotices } from "./notices"
import { productionGenerationManagerOf } from "./runner/generation-manager"
import {
  isPackagedPluginRuntime,
  startProductionPluginRunner,
} from "./runner/production"
import {
  dropLegacyPluginConfig,
  legacyPluginConfigs,
  migratePluginSettings,
} from "./settings"
import { listPluginViews, PLUGIN_CLIENTS } from "./view"

/** Gateway events come in bursts (a reload is stop + start + status +
 *  tools); Settings gets one `plugins.changed` per burst. */
const NOTIFY_DELAY_MS = 100
/** Share of the 2.5 s shutdown budget plugins get to stop. */
const STOP_TIMEOUT_MS = 1_500

let unsubscribeGateway: (() => void) | undefined
let notifyTimer: ReturnType<typeof setTimeout> | undefined

/** Tell Settings (SSE `plugins.changed`) that something changed. */
export function notifyPluginsChanged(): void {
  if (notifyTimer) return
  notifyTimer = setTimeout(() => {
    notifyTimer = undefined
    const gateway = getPluginGateway()
    if (!gateway) return
    listPluginViews(gateway)
      .then((views) => settingsEventBus.publish("plugins.changed", views))
      .catch((error: unknown) => {
        consola.warn("Could not publish the plugin list", error)
      })
  }, NOTIFY_DELAY_MS)
  notifyTimer.unref()
}

/**
 * Bring every client's MCP entries in line with the config and what the
 * client already has (see `clients/sync`); tells Settings when an entry
 * changed. Cheap and idempotent, so Settings reads call it too. Never
 * throws; a client that fails is logged.
 */
export function syncPluginClients(): void {
  let changed = false
  for (const configurator of PLUGIN_CLIENTS) {
    try {
      changed = syncPluginClient(configurator) || changed
    } catch (error) {
      consola.warn(
        `Could not update ${configurator.clientId} MCP servers`,
        error,
      )
    }
  }
  if (changed) notifyPluginsChanged()
}

/**
 * Move each legacy `config.json` → `plugins.<id>.config` into the plugin's
 * settings file, then drop it from `config.json`. A value the host could not
 * take (unreadable settings file) stays where it is for the next boot.
 * Unknown ids are left alone. Never throws.
 */
export async function importLegacyPluginConfigs(
  gateway: PluginGateway,
): Promise<void> {
  const known = new Set(gateway.list().map((snapshot) => snapshot.id))
  for (const { id, config } of legacyPluginConfigs(getConfig())) {
    if (!known.has(id)) continue
    try {
      const written = await gateway.importLegacyConfig(id, config)
      dropLegacyPluginConfig(id)
      consola.info(
        written ?
          `Moved ${id}'s config from config.json into its settings file`
        : `Dropped ${id}'s old config.json config; its settings file already has one`,
      )
    } catch (error) {
      consola.warn(
        `Could not move ${id}'s config into its settings file`,
        error,
      )
    }
  }
}

export interface StartPluginsOptions {
  /** Use this gateway instead of composing the built-in plugins (the
   *  connectors bench passes one built from `composePluginGateway`). */
  gateway?: PluginGateway
  /** Runner seam for startup policy tests. */
  startRunner?: typeof startProductionPluginRunner
  /** Runtime classification seam for startup policy tests. */
  packagedRuntime?: boolean
}

/**
 * Boot: migrate old settings, create the gateway, start what is enabled,
 * then register endpoints with clients. A broken plugin list is logged and
 * leaves the proxy running without plugins.
 */
export async function startPlugins(
  options: StartPluginsOptions = {},
): Promise<PluginGateway | undefined> {
  migratePluginSettings()
  removeLegacyClaudeDesktopEntries()
  let gateway: PluginGateway
  try {
    if (options.gateway) gateway = options.gateway
    else {
      const packagedRuntime =
        options.packagedRuntime ?? isPackagedPluginRuntime()
      try {
        const supervised = await (
          options.startRunner ?? startProductionPluginRunner
        )()
        if (supervised) gateway = supervised
        else if (packagedRuntime)
          throw new Error(
            "This Maximal release has no compatible packaged built-in plugin generation.",
          )
        else {
          consola.info(
            "No packaged plugin generation is available in source mode; using the in-process built-ins",
          )
          gateway = composePluginGateway()
        }
      } catch (error) {
        if (packagedRuntime) throw error
        consola.warn(
          "The supervised plugin generation is unavailable in source mode; using the in-process built-ins",
          error,
        )
        gateway = composePluginGateway()
      }
    }
  } catch (error) {
    consola.error("Plugins are unavailable", error)
    return undefined
  }
  unsubscribeGateway?.()
  setPluginGateway(gateway)
  // Notices belong to the gateway that raised them.
  takePluginNotices()
  // Every event (lifecycle, status, tools, settings) changes what Settings
  // shows; bursts collapse into one `plugins.changed`.
  unsubscribeGateway = gateway.subscribe((event) => {
    // A notice changes nothing Settings shows; it goes to the shell.
    if (event.type === "notice") {
      queuePluginNotice(
        event,
        gateway.get(event.pluginId)?.displayName ?? event.pluginId,
      )
      return
    }
    notifyPluginsChanged()
  })
  await reloadComposedPluginInventory(gateway, getConfig().pluginInventory)
  await importLegacyPluginConfigs(gateway)
  await gateway.reconcile(getConfig().plugins)
  syncPluginClients()
  return gateway
}

/** After `config.plugins` changed: start/stop/reload plugins to match, then
 *  update the clients. */
export async function applyPluginSettings(): Promise<void> {
  const gateway = getPluginGateway()
  if (!gateway) return
  const config = getConfig()
  await reloadComposedPluginInventory(gateway, config.pluginInventory)
  // A supervised gateway cuts over to whichever sealed generation is selected
  // now (N -> N+1; `config.pluginInventory` is staged into one) before the
  // settings are applied to the serving generation. A failed candidate leaves
  // the current generation serving.
  const manager = productionGenerationManagerOf(gateway)
  if (manager) {
    try {
      await manager.refresh()
    } catch (error) {
      consola.warn(
        "Could not switch plugin generations; the current generation keeps serving",
        error,
      )
    }
  }
  await gateway.reconcile(config.plugins)
  syncPluginClients()
}

const stoppingHooks = new Set<() => Promise<void> | void>()

/** Run `hook` at the start of `stopPlugins`, before the gateway goes away
 *  (the MCP routes close their sessions here). Lets `src/routes` take part in
 *  shutdown without `src/lib` importing it. */
export function onPluginsStopping(hook: () => Promise<void> | void): void {
  stoppingHooks.add(hook)
}

/** Shutdown: stop every plugin (bounded). Idempotent. */
export async function stopPlugins(): Promise<void> {
  const gateway = getPluginGateway()
  await Promise.all(
    [...stoppingHooks].map(async (hook) => {
      try {
        await hook()
      } catch (error) {
        consola.warn("Could not close a plugin endpoint cleanly", error)
      }
    }),
  )
  unsubscribeGateway?.()
  unsubscribeGateway = undefined
  if (notifyTimer) clearTimeout(notifyTimer)
  notifyTimer = undefined
  setPluginGateway(undefined)
  if (!gateway) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      consola.warn("Plugins took too long to stop")
      resolve()
    }, STOP_TIMEOUT_MS)
    timer.unref()
  })
  try {
    await Promise.race([gateway.dispose(), timeout])
  } catch (error) {
    consola.warn("Could not stop plugins cleanly", error)
  } finally {
    clearTimeout(timer)
  }
}
