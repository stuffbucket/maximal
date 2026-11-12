import type { PluginManifest } from "@stuffbucket/maximal-plugin-sdk"

import { z } from "zod"

/** The provider-model pairs this plugin serves `/v1/decisions` for. */
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
  model: "gpt-6-luna-decisions",
  provider: "copilot",
  upstreamModel: "gpt-6-luna-decisions",
} as const

export const Config = z.object({
  bindings: z.array(Binding).min(1).default([DEFAULT_BINDING]).meta({
    title: "Models",
    description:
      "The models served on /v1/decisions, each bound to the provider model that answers it.",
  }),
  tools: z
    .object({
      decide: z.boolean().default(true).meta({
        title: "decide tool for Claude Code",
        description:
          "Offer the decide tool to Claude Code, so it can ask this model for yes/no, choice and score answers while it works. Free on Copilot.",
      }),
    })
    .default({ decide: true })
    .meta({ title: "Tools" }),
})

export type DecisionsConfig = z.output<typeof Config>

const { $schema: _dialect, ...configSchema } = z.toJSONSchema(Config, {
  io: "input",
})

export const DECISIONS_MANIFEST: PluginManifest = {
  id: "decisions",
  kind: "model",
  displayName: "Decisions",
  description:
    "Serves the OpenAI Decisions API (/v1/decisions): structured yes/no, choice and score answers from a decision model.",
  settingsVersion: 1,
  configSchema: { ...configSchema, type: "object" },
}
