/**
 * `bun run bench:connectors [--drive] [--entitlement=full|partial|none] [--port=N] [--verbose]`
 *
 * Runs the real Maximal server (`runServer`) in this process with the real
 * Work IQ connector pointed at a fake Work IQ MCP server and a fake sign-in
 * that completes instantly as bench@contoso.com — the whole Connectors
 * experience (Settings → Integrations → Connectors, `/mcp/workiq`) without a
 * Microsoft account or network. Everything runs in a throwaway user
 * environment (HOME, app data, Claude config), removed on exit, so nothing
 * touches your real setup.
 *
 * Without `--drive` it prints the Settings URL and the MCP endpoint + API
 * key and keeps serving until Ctrl-C. With `--drive` it runs a scripted MCP
 * client session against it (sign in, list, block/unblock, calls, a
 * policy-denied call), prints a pass/fail table and exits non-zero on any
 * failure. `--entitlement` shows the admin-restricted states.
 *
 * The UI comes from `shell/dist/ui` (`bun run build:ui`).
 */

import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

import { createTestUserSandbox } from "../../tests/helpers/user-sandbox"

const ENTITLEMENTS = ["full", "partial", "none"] as const
type Entitlement = (typeof ENTITLEMENTS)[number]

function isEntitlement(value: string): value is Entitlement {
  return (ENTITLEMENTS as ReadonlyArray<string>).includes(value)
}

const { values } = parseArgs({
  options: {
    drive: { type: "boolean", default: false },
    entitlement: { type: "string", default: "full" },
    port: { type: "string", default: "0" },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
})

if (values.help) {
  console.log(
    "Usage: bun run bench:connectors [--drive] [--entitlement=full|partial|none] [--port=N] [--verbose]",
  )
  process.exit(0)
}
if (!isEntitlement(values.entitlement)) {
  console.error(
    `--entitlement must be one of ${ENTITLEMENTS.join(", ")} (got "${values.entitlement}")`,
  )
  process.exit(2)
}
const entitlement = values.entitlement
const port = Number(values.port)
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  console.error(`--port must be a port number (got "${values.port}")`)
  process.exit(2)
}

// Contain the user environment BEFORE any app module loads (paths are
// resolved at import time), and remove it however the process ends: Ctrl-C
// goes through Maximal's own shutdown, which exits the process.
const sandbox = createTestUserSandbox()
process.env.HOST = "127.0.0.1"
// No update check against the real manifest server.
process.env.MAXIMAL_TEST_UPDATE_MANIFEST_URL ??=
  "http://127.0.0.1:9/updates/manifest.json"
process.on("exit", () => {
  fs.rmSync(sandbox.root, { recursive: true, force: true })
})

const { runServer } = await import("../../src/lib/start/run-server")
const { currentProxyPort } = await import("../../src/lib/start/proxy-port")
const { driveConnectorsBench, formatChecks, startConnectorsBench } =
  await import("./connectors-bench")

const bench = await startConnectorsBench({
  entitlement,
  async startServer(gateway) {
    await runServer({
      port,
      verbose: values.verbose,
      accountType: "individual",
      manual: false,
      rateLimitWait: false,
      claudeCode: false,
      showToken: false,
      proxyEnv: false,
      pluginGateway: gateway,
    })
    return {
      origin: `http://127.0.0.1:${currentProxyPort()}`,
      // Maximal's shutdown (Ctrl-C, or process exit) stops everything.
      stop: () => Promise.resolve(),
    }
  },
})

const uiBuilt = fs.existsSync(
  path.join(import.meta.dir, "..", "..", "shell", "dist", "ui", "settings", "index.html"),
)
console.log(`
Connectors bench (Work IQ, entitlement: ${entitlement})
  Settings      ${bench.settingsUrl}${uiBuilt ? "" : "\n                (no UI bundle yet: run `bun run build:ui`, then reload)"}
  MCP endpoint  ${bench.mcpUrl}
  API key       ${bench.apiKey}   (Authorization: Bearer …; attribution only, auth isn't enforced)
  Fake Work IQ  ${bench.fake.url}
  Sandbox       ${sandbox.root}

  Claude Code:  claude mcp add --transport http workiq ${bench.mcpUrl} --header "Authorization: Bearer ${bench.apiKey}"
  On the Connectors page, accept the terms and sign in (instant, as bench@contoso.com).
`)

if (values.drive) {
  const rows = await driveConnectorsBench(bench)
  console.log(formatChecks(rows))
  process.exit(rows.every((row) => row.ok) ? 0 : 1)
} else {
  console.log("Serving until Ctrl-C.")
}
