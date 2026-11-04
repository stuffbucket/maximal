/**
 * Plugin lifecycle inside the serving process: boot, settings changes,
 * client sync, Settings events, shutdown.
 */

import type { PluginGateway } from "@stuffbucket/maximal-plugin-sdk/gateway"

import consola from "consola"

import { getConfig } from "~/lib/config/config"
import { settingsEventBus } from "~/lib/config/settings-events"

import { removeLegacyClaudeDesktopEntries } from "./clients/claude-desktop-cleanup"
import {
  releasePluginClientOffline,
  type SyncPluginClientOptions,
  syncPluginClient,
} from "./clients/sync"
import { composePluginGateway } from "./compose"
import { getPluginGateway, setPluginGateway } from "./gateway"
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

/** Bring every client's MCP entries in line with `config.plugins`. Never
 *  rejects; a client that fails is logged. */
export async function syncPluginClients(
  options: SyncPluginClientOptions = {},
): Promise<void> {
  for (const configurator of PLUGIN_CLIENTS) {
    try {
      await syncPluginClient(configurator, options)
    } catch (error) {
      consola.warn(
        `Could not update ${configurator.clientId} MCP servers`,
        error,
      )
    }
  }
  notifyPluginsChanged()
}

/** Shutdown: take Maximal's entries back out of clients that read their
 *  config per session. Synchronous and file-only (the `exit` safety net). */
export function releasePluginClientsOnShutdown(): void {
  for (const configurator of PLUGIN_CLIENTS) {
    try {
      releasePluginClientOffline(configurator)
    } catch (error) {
      consola.warn(
        `Could not remove ${configurator.clientId} MCP servers on shutdown`,
        error,
      )
    }
  }
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
    gateway = options.gateway ?? composePluginGateway()
  } catch (error) {
    consola.error("Plugins are unavailable", error)
    return undefined
  }
  unsubscribeGateway?.()
  setPluginGateway(gateway)
  // Every event (lifecycle, status, tools, settings) changes what Settings
  // shows; bursts collapse into one `plugins.changed`.
  unsubscribeGateway = gateway.subscribe(() => notifyPluginsChanged())
  await importLegacyPluginConfigs(gateway)
  await gateway.reconcile(getConfig().plugins)
  await syncPluginClients()
  return gateway
}

/** After `config.plugins` changed: start/stop/reload plugins to match, then
 *  update the clients. */
export async function applyPluginSettings(): Promise<void> {
  const gateway = getPluginGateway()
  if (!gateway) return
  await gateway.reconcile(getConfig().plugins)
  await syncPluginClients()
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
