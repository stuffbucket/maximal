import type { PluginManifest } from "@stuffbucket/maximal-plugin-sdk"

import { z } from "zod"

/** Where the FigJam panel and coding agents reach the bridge. */
export const DEFAULT_BRIDGE_PORT = 4150

const port = (title: string, description: string, fallback: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(65_535)
    .default(fallback)
    .meta({ title, description })

export const Config = z.object({
  port: port(
    "Bridge port",
    "The local WebSocket port the FigJam panel connects to. Set up the Figma plugin again after changing it.",
    DEFAULT_BRIDGE_PORT,
  ),
})

export type FigjamConfig = z.output<typeof Config>

const { $schema: _dialect, ...configSchema } = z.toJSONSchema(Config, {
  io: "input",
})

export const FIGJAM_MANIFEST: PluginManifest = {
  id: "figjam",
  kind: "extension",
  displayName: "FigJam",
  description:
    "Lets the Maximal agent panel in FigJam, and coding agents on this computer, read and change FigJam boards. Opens a local port.",
  settingsVersion: 1,
  configSchema: { ...configSchema, type: "object" },
}
