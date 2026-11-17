/**
 * One FigJam plugin generation in its own process, the way the plugin runner
 * hosts it: load the real plugin, make sure the Figma plugin folder is set
 * up, print the relay key stamped into its panel, and exit.
 *
 *   bun generation.ts <storageDir> <dataDir> <bridgePort>
 */
import { loadPlugin, waitFor } from "@stuffbucket/maximal-plugin-sdk/testing"
import { readFile } from "node:fs/promises"
import path from "node:path"

import { createFigjamPlugin, FIGMA_PLUGIN_DIR } from "../../src/index"

const [storageDir, dataDir, portArg] = process.argv.slice(2)
if (!storageDir || !dataDir || !portArg) {
  throw new Error("usage: generation.ts <storageDir> <dataDir> <bridgePort>")
}

const loaded = await loadPlugin(
  createFigjamPlugin({ dataDir }),
  { port: Number(portArg) },
  { storageDir },
)
const code = () => loaded.status()?.code
await waitFor(() => code() === "plugin-not-built" || code() === "ready")
if (code() === "plugin-not-built") await loaded.runAction("setup")
await waitFor(() => code() === "ready")

const html = await readFile(
  path.join(storageDir, "figjam", FIGMA_PLUGIN_DIR, "ui.html"),
  "utf8",
)
const line = /^const PANEL_BUILD = (.*);$/m.exec(html)
if (!line) throw new Error("no PANEL_BUILD line in ui.html")
await loaded.dispose()
console.log((JSON.parse(line[1]) as { relayKey: string }).relayKey)
process.exit(0)
