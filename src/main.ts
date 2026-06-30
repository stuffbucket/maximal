#!/usr/bin/env node

import { defineCommand, runMain, parseArgs } from "citty"

import { BUILD_VERSION } from "./lib/build-info"
import { bindElectronFetch } from "./lib/electron-fetch"

const cliArgs = {
  apiKeyHelper: {
    type: "string",
    description: "Print the API key for an integrated client.",
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

// Dynamically import other modules to ensure environment variables are set
const { auth } = await import("./auth")
const { checkUsage } = await import("./check-usage")
const { getAppCliCommands } = await import("./apps/registry")
const { debug } = await import("./debug")
const { setup } = await import("./setup")
const { start } = await import("./start")
const { uninstall } = await import("./uninstall")

const main = defineCommand({
  meta: {
    name: "maximal",
    version: BUILD_VERSION,
    description:
      "Local proxy that exposes GitHub Copilot as OpenAI- and Anthropic-compatible HTTP endpoints.",
  },
  subCommands: {
    auth,
    start,
    setup,
    ...getAppCliCommands(),
    uninstall,
    "check-usage": checkUsage,
    debug,
  },
  args: cliArgs,
})

await runMain(main)
