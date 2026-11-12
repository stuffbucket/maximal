import type { PluginManifest } from "@stuffbucket/maximal-plugin-sdk"

import { z } from "zod"

/** The provider-model pairs this plugin serves `/v1/systemone` for. */
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
  model: "microsoft-decision-1",
  provider: "copilot",
  upstreamModel: "microsoft-decision-1",
} as const

export const Config = z.object({
  bindings: z.array(Binding).min(1).default([DEFAULT_BINDING]).meta({
    title: "Models",
    description:
      "The models served on /v1/systemone, each bound to the provider model that answers it.",
  }),
})

export type SystemOneConfig = z.output<typeof Config>

const { $schema: _dialect, ...configSchema } = z.toJSONSchema(Config, {
  io: "input",
})

export const SYSTEMONE_MANIFEST: PluginManifest = {
  id: "systemone",
  kind: "model",
  displayName: "SystemOne",
  description:
    "Serves SystemOne (/v1/systemone): Microsoft Decision answers (yes/no, choice, score) over a given text or state. Needs a Copilot plan that includes the model.",
  settingsVersion: 1,
  configSchema: { ...configSchema, type: "object" },
}
