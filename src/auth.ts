#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"

import { setupGitHubToken } from "./lib/auth/token"
import { PATHS, ensurePaths } from "./lib/platform/paths"
import { state } from "./lib/runtime-state/state"

interface RunAuthOptions {
  verbose: boolean
  showToken: boolean
}

export async function runAuth(options: RunAuthOptions): Promise<void> {
  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.showToken = options.showToken

  await ensurePaths()
  await setupGitHubToken({ force: true })
  consola.success(`Signed in. Saved to ${PATHS.ACCOUNTS_PATH}.`)
  consola.info(
    "A running Maximal that is signed out picks this up within a few seconds.",
  )
}

export const auth = defineCommand({
  meta: {
    name: "auth",
    description: "Run GitHub auth flow without running the server",
  },
  args: {
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub token on auth",
    },
  },
  run({ args }) {
    return runAuth({
      verbose: args.verbose,
      showToken: args["show-token"],
    })
  },
})
