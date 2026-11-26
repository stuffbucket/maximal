#!/usr/bin/env bun
/**
 * CLI entry for the FigJam bridge: `bun run figjam:bridge`. Everything lives in
 * server.ts so other workspaces can embed it with `startBridge`.
 *
 * A panel opens the bridge socket only with this run's relay key, so the CLI
 * writes the Figma development plugin itself, stamped with that key and the
 * bridge's port: into the figjam-plugin package's `dist/dev` (what
 * `bun run figjam:build` writes), or `FIGJAM_PLUGIN_OUT`. Restarting the
 * bridge makes a new key; run the plugin again in Figma to pick it up.
 */
import {
  buildPlugin,
  defaultOutDir,
} from "@stuffbucket/maximal-figjam-plugin/build"
import path from "node:path"

import { startBridge } from "./server"

if (import.meta.main) {
  const bridge = await startBridge()
  const outDir = path.resolve(process.env.FIGJAM_PLUGIN_OUT ?? defaultOutDir())
  try {
    await buildPlugin({
      outDir,
      bridgePort: bridge.port,
      relayKey: bridge.relayKey,
    })
    console.log(
      `Figma development plugin for this bridge: ${path.join(outDir, "manifest.json")} (after a bridge restart, run the plugin again)`,
    )
  } catch (error) {
    console.error(
      `Could not write the Figma development plugin to ${outDir}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
