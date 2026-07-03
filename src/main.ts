#!/usr/bin/env node

import { defineCommand, runMain, parseArgs } from "citty"

import { HELPER_SUBCOMMAND } from "./lib/api-key-helper-tokens"
import { BUILD_VERSION } from "./lib/build-info"
import { bindElectronFetch } from "./lib/electron-fetch"

const cliArgs = {
  apiKeyHelper: {
    type: "string",
    description:
      "Legacy alias for `maximal api <client>`; the command written into"
      + " client configs. Prints the API key for an integrated client.",
  },
  "api-home": {
    type: "string",
    description: "Path to the API home directory.",
  },
  "oauth-app": {
    type: "string",
    description: "OAuth app identifier.",
  },
  "enterprise-url": {
    type: "string",
    description: "Enterprise URL for GitHub.",
  },
} as const

const args = parseArgs(process.argv, cliArgs)

// Set environment variables before loading other modules
if (typeof args["api-home"] === "string") {
  process.env.COPILOT_API_HOME = args["api-home"]
}
if (typeof args["oauth-app"] === "string") {
  process.env.COPILOT_API_OAUTH_APP = args["oauth-app"]
}
if (typeof args["enterprise-url"] === "string") {
  process.env.COPILOT_API_ENTERPRISE_URL = args["enterprise-url"]
}

if (typeof args.apiKeyHelper === "string") {
  const { runApiKeyHelper } = await import("./lib/api-key-helper")
  process.exit(runApiKeyHelper(args.apiKeyHelper))
}

bindElectronFetch()

// Subcommands are LAZY thunks: citty resolves `meta` for `--help`/usage but
// only invokes the matched command's loader. This keeps each invocation from
// paying the import cost of the others — e.g. `maximal api <client>` (invoked by
// clients via `sh -c` on every key fetch) must not load the proxy server,
// usage client, or auth stack it never touches.
const main = defineCommand({
  meta: {
    name: "maximal",
    version: BUILD_VERSION,
    description:
      "Local proxy that exposes GitHub Copilot as OpenAI- and Anthropic-compatible HTTP endpoints.",
  },
  subCommands: {
    auth: () => import("./auth").then((m) => m.auth),
    start: () => import("./start").then((m) => m.start),
    setup: () => import("./setup").then((m) => m.setup),
    app: () => import("./apps/cli").then((m) => m.appCommand),
    // Keyed by HELPER_SUBCOMMAND so the on-disk `<bin> api <client>` token and
    // the command citty dispatches share one source of truth (no drift).
    [HELPER_SUBCOMMAND]: () => import("./apps/cli").then((m) => m.apiCommand),
    uninstall: () => import("./uninstall").then((m) => m.uninstall),
    "check-usage": () => import("./check-usage").then((m) => m.checkUsage),
    debug: () => import("./debug").then((m) => m.debug),
  },
  args: cliArgs,
})

await runMain(main)
