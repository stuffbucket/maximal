/**
 * Registry-driven CLI surface for third-party client integrations.
 *
 * Two commands, both generated from the app registry so a new client shows up
 * automatically once it's registered:
 *
 *   maximal app  [client] [--enable|--disable]   # configure/inspect a client
 *   maximal app  list                            # list registered clients
 *   maximal api  [client]                         # print the client's API key
 *   maximal api  list                            # list registered clients
 *
 * `app <client>` with no flag SHOWS status (never mutates). `--enable` /
 * `--disable` drive the same `ClientApp.enable()` / `disable()` the Settings UI
 * uses, so the CLI and the shell stay in lockstep. Apps that need extra flags
 * (e.g. Claude Desktop's `--force` / `--managed`) hook in via `ClientApp.cli`.
 *
 * `api <client>` is the canonical human surface for a client's key; the
 * `--apiKeyHelper <label>` flag is the machine/legacy alias (the exact string
 * written into client configs). Both funnel through the same resolver in
 * `~/lib/api-key-helper`, keyed by the app's declared `apiKeyLabel` — so the
 * key a client's config helper prints and the key `maximal api <client>` prints
 * are guaranteed identical.
 */
import type { ArgsDef, CommandDef } from "citty"

import { defineCommand } from "citty"
import consola from "consola"

import { runApiKeyHelper } from "~/lib/api-key-helper"
import { HELPER_SUBCOMMAND } from "~/lib/api-key-helper-tokens"

import type { AppCliOp, ClientApp } from "./index"

import { getAllApps } from "./registry"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches citty's SubCommandsDef = Record<string, Resolvable<CommandDef<any>>>
type AnyCommand = CommandDef<any>

/** Shared status/enable/disable flags every `app <client>` command carries. */
const APP_OP_ARGS = {
  enable: {
    type: "boolean",
    default: false,
    description: "Point this client at the local proxy.",
  },
  disable: {
    type: "boolean",
    default: false,
    description: "Remove the proxy routing this client integration wrote.",
  },
} as const satisfies ArgsDef

/** Which operation the flags select. `--disable` wins if both are passed (it's
 *  the safe direction: it only removes what we own). No flag → status. */
function selectOp(args: Record<string, unknown>): AppCliOp {
  if (args.disable === true) return "disable"
  if (args.enable === true) return "enable"
  return "status"
}

async function showStatus(app: ClientApp): Promise<void> {
  const details = await app.getDetails()
  consola.info(`${details.name} (${details.id})`)
  consola.info(`  status:  ${details.status}`)
  consola.info(`  routing: ${details.enabled ? "enabled" : "disabled"}`)
  for (const i of details.installs) {
    consola.info(`  install: ${i.path}${i.version ? ` (${i.version})` : ""}`)
  }
  if (details.conflict) {
    consola.warn(`  conflict: ${details.conflict}`)
  }
  if (details.install) {
    consola.info(`  install with: ${details.install.command}`)
  }
}

async function enableApp(app: ClientApp): Promise<void> {
  const result = await app.enable()
  if (result.conflict) {
    consola.warn(
      `Left ${app.name} untouched: a ${result.conflict} is already set.`
        + " Remove it first if you want proxy routing.",
    )
    return
  }
  if (result.success) {
    consola.success(`Pointed ${app.name} at the local proxy.`)
  } else {
    consola.warn(`Could not enable ${app.name}.`)
  }
}

async function disableApp(app: ClientApp): Promise<void> {
  const result = await app.disable()
  if (result.success) {
    consola.success(`Removed proxy routing for ${app.name}.`)
  } else {
    consola.info(`${app.name} wasn't routed by us; nothing to do.`)
  }
}

async function runAppOp(
  app: ClientApp,
  args: Record<string, unknown>,
): Promise<void> {
  const op = selectOp(args)
  // Give the app first crack (extra flags / bespoke handling — e.g. a
  // coming-soon app intercepts enable/disable here). If it fully handled the
  // op, we're done; otherwise fall through to the generic path.
  if (app.cli?.handle) {
    const handled = await app.cli.handle(op, args)
    if (handled) return
  }
  if (op === "enable") return enableApp(app)
  if (op === "disable") return disableApp(app)
  return showStatus(app)
}

/** One `maximal app <client>` subcommand, merging the shared op flags with any
 *  extras the app declares. */
function appClientCommand(app: ClientApp): AnyCommand {
  return defineCommand({
    meta: {
      name: app.id,
      description: `Configure or inspect the ${app.name} integration.`,
    },
    args: { ...APP_OP_ARGS, ...app.cli?.extraArgs },
    async run({ args }) {
      await runAppOp(app, args)
    },
  })
}

/** `maximal app list` / `maximal api list` — the registered client ids. Shared
 *  because "what clients exist" is the same question for both commands. */
const listCommand: AnyCommand = defineCommand({
  meta: {
    name: "list",
    description: "List the registered client integrations.",
  },
  run() {
    for (const app of getAllApps()) {
      consola.info(`${app.id}\t${app.name}`)
    }
  },
})

function clientSubcommands(
  build: (app: ClientApp) => AnyCommand,
): Record<string, AnyCommand> {
  const subs: Record<string, AnyCommand> = { list: listCommand }
  for (const app of getAllApps()) {
    subs[app.id] = build(app)
  }
  return subs
}

export const appCommand: AnyCommand = defineCommand({
  meta: {
    name: "app",
    description:
      "Configure or inspect a client integration: `maximal app <client>`"
      + " (no flag shows status; --enable/--disable to change it). `list` for"
      + " the available clients.",
  },
  subCommands: clientSubcommands(appClientCommand),
})

/** `maximal api <client>` — print the API key that client should present to the
 *  proxy, resolved by the SAME core as `--apiKeyHelper <label>` using the app's
 *  declared `apiKeyLabel`. An app with no `apiKeyLabel` (e.g. a coming-soon
 *  placeholder) has no key surface: we report that and exit 1 rather than
 *  minting the default endpoint key. */
function reportNoApiKey(app: ClientApp): number {
  process.stderr.write(`ERROR: ${app.name} has no API key to print.\n`)
  return 1
}

function apiClientCommand(app: ClientApp): AnyCommand {
  return defineCommand({
    meta: {
      name: app.id,
      description: `Print the API key for the ${app.name} client.`,
    },
    run() {
      process.exitCode =
        app.apiKeyLabel === undefined ?
          reportNoApiKey(app)
        : runApiKeyHelper(app.apiKeyLabel)
    },
  })
}

export const apiCommand: AnyCommand = defineCommand({
  meta: {
    name: HELPER_SUBCOMMAND,
    description:
      "Print a client's API key: `maximal api <client>` — the canonical"
      + " surface (`--apiKeyHelper` is the legacy/machine alias). `list` for the"
      + " available clients.",
  },
  subCommands: clientSubcommands(apiClientCommand),
})
