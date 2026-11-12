import type { PluginManifest } from "@stuffbucket/maximal-plugin-sdk"

import { z } from "zod"

/** The provider-model pairs this plugin serves `/v1/images/*` for. */
export const Binding = z.object({
  model: z
    .string()
    .min(1)
    .meta({ title: "Model", description: "The id clients send." }),
  provider: z.string().min(1).meta({
    title: "Provider",
    description: "The upstream provider that serves it.",
  }),
  upstreamModel: z.string().min(1).meta({
    title: "Provider model",
    description: "The provider's own id for the model.",
  }),
})

export const DEFAULT_BINDING = {
  model: "gpt-image-2.5-flare",
  provider: "copilot",
  upstreamModel: "gpt-image-2.5-flare",
} as const

export const Config = z.object({
  bindings: z.array(Binding).min(1).default([DEFAULT_BINDING]).meta({
    title: "Models",
    description:
      "The models served on /v1/images/generations and /v1/images/edits, each bound to the provider model that answers it.",
  }),
})

export type ImagesConfig = z.output<typeof Config>

const { $schema: _dialect, ...configSchema } = z.toJSONSchema(Config, {
  io: "input",
})

export const IMAGES_MANIFEST: PluginManifest = {
  id: "images",
  kind: "model",
  displayName: "Images",
  description:
    "Serves image generation and edits (/v1/images/generations and /v1/images/edits), as JSON or a multipart form, from an image model.",
  settingsVersion: 1,
  configSchema: { ...configSchema, type: "object" },
}
