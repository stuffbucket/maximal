#!/usr/bin/env node
/**
 * `maximal setup-status` — machine-readable mirror of the HTTP
 * `/setup-status` route. Prints `evaluateSetup()` as JSON to stdout
 * and exits 0 if ready, 1 if not.
 *
 * Same payload shape as the HTTP route so shell scripts and the
 * claude-code plugin can use whichever surface is convenient. See
 * docs/first-run-setup-prd.md, "Open Questions" #4.
 */

import { defineCommand } from "citty"

import { evaluateSetup } from "./lib/setup-status"

export const setupStatus = defineCommand({
  meta: {
    name: "setup-status",
    description:
      "Print first-run setup readiness as JSON. Exits 0 if ready, 1 if not.",
  },
  async run() {
    const status = await evaluateSetup()
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
    process.exit(status.ready ? 0 : 1)
  },
})
