/**
 * Composition root for the plugin system — the ONLY module in `src/` that
 * imports the cordis-backed host (`@stuffbucket/maximal-plugin-host`) and
 * plugin packages (dependency-cruiser enforces it). Everything else in the
 * app talks to the cordis-free `PluginGateway` seam
 * (`@stuffbucket/maximal-plugin-sdk/gateway`).
 *
 * Builds the `HostServices` the plugins get on `ctx.host` (browser, logger,
 * version), points `ctx.storage` at `<app dir>/plugins/<id>/`, and lists the
 * built-in plugins.
 */

import type { PluginGateway } from "@stuffbucket/maximal-plugin-sdk/gateway"

import {
  createPluginHost,
  type HostServices,
  operationsService,
  type PluginModule,
  providersService,
} from "@stuffbucket/maximal-plugin-host"
import * as workiq from "@stuffbucket/maximal-plugin-workiq"
import consola from "consola"
import path from "node:path"

import { openUrl } from "~/lib/platform/open-url"
import { PATHS } from "~/lib/platform/paths"
import {
  type CopilotProviderDeps,
  createCopilotProvider,
} from "~/lib/plugins/providers/copilot"
import { runFile } from "~/lib/system/run-file"
import { BUILD_VERSION } from "~/lib/update/build-info"

/** The first-party plugins every Maximal build ships. */
const BUILTIN_PLUGINS: ReadonlyArray<PluginModule> = [workiq]

const OPEN_TIMEOUT_MS = 10_000

/** Where `ctx.storage` keeps each plugin's private directory. */
export function pluginStorageRoot(appDir: string = PATHS.APP_DIR): string {
  return path.join(appDir, "plugins")
}

/** The URL the system launcher gets: parsed and re-serialized (`href`), and
 *  only if it is http(s). The SDK checks the scheme too, but this is the last
 *  stop before a process spawn, so it doesn't trust the raw string. */
export function normalizeExternalUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http(s) URLs can be opened.")
  }
  return parsed.href
}

/** Open an http(s) URL in the system browser. The host has already checked
 *  the scheme. */
async function openExternal(rawUrl: string): Promise<void> {
  const url = normalizeExternalUrl(rawUrl)
  if (process.platform === "win32") {
    // `cmd /c start` would split a sign-in URL at its `&`s; the URL handler
    // takes the whole string as one argument, with no shell in between.
    const result = await runFile(
      "rundll32",
      ["url.dll,FileProtocolHandler", url],
      { timeoutMs: OPEN_TIMEOUT_MS },
    )
    if (result.notFound || result.code !== 0) {
      throw new Error("Could not open the browser.")
    }
    return
  }
  const result = openUrl(url)
  if (!result.ok) {
    throw new Error(
      result.reason === "headless" ?
        "There is no desktop session to open a browser in."
      : "Could not open the browser.",
    )
  }
}

function hostServices(): HostServices {
  // The host and `ctx.host.logger` already prefix each line with
  // `[plugins]` / the plugin id.
  return {
    openExternal,
    appVersion: BUILD_VERSION,
    logger: {
      debug: (message, ...args) => consola.debug(message, ...args),
      info: (message, ...args) => consola.info(message, ...args),
      warn: (message, ...args) => consola.warn(message, ...args),
      error: (message, ...args) => consola.error(message, ...args),
    },
  }
}

export interface ComposePluginsOptions {
  /** The plugin set; the built-ins by default. Tests and the connectors
   *  bench (`scripts/bench/connectors.ts`) pass their own — the only way to
   *  swap plugins; nothing in production reads an override. */
  plugins?: ReadonlyArray<PluginModule>
  /** Defaults to `<app dir>/plugins`. */
  storageRoot?: string
  /** Replace individual host services (tests record `openExternal`). */
  host?: Partial<HostServices>
  /** Replace parts of the Copilot upstream provider (tests inject a fake
   *  `sendRequest`). */
  copilot?: CopilotProviderDeps
}

/**
 * Create the plugin gateway. Every plugin starts disabled; the caller runs
 * `reconcile(config.plugins)`. Throws `PluginContractError` when the plugin
 * list itself is invalid.
 */
export function composePluginGateway(
  options: ComposePluginsOptions = {},
): PluginGateway {
  return createPluginHost({
    plugins: options.plugins ?? BUILTIN_PLUGINS,
    services: {
      host: { ...hostServices(), ...options.host },
      storageRoot: options.storageRoot ?? pluginStorageRoot(),
      extra: [
        operationsService,
        providersService([createCopilotProvider(options.copilot)]),
      ],
    },
  })
}
