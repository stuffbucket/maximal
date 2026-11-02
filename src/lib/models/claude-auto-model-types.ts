import { z } from "zod"

export const ClaudeAutoAutomaticReason = z.enum([
  "haiku",
  "sonnet",
  "small-gpt",
  "gpt",
])
export type ClaudeAutoAutomaticReason = z.infer<
  typeof ClaudeAutoAutomaticReason
>

const AutomaticTierState = z.object({
  configured: z.null(),
  effective: z.string(),
  source: z.literal("automatic"),
  status: z.literal("ready"),
  reason: ClaudeAutoAutomaticReason,
})

const OverrideTierState = z.object({
  configured: z.string(),
  effective: z.string(),
  source: z.literal("maximal-override"),
  status: z.literal("ready"),
  reason: z.literal("override"),
})

const ExternalTierState = z.object({
  configured: z.string().nullable(),
  effective: z.string().nullable(),
  source: z.literal("claude-code-setting"),
  status: z.literal("ready"),
  reason: z.literal("external-setting"),
})

const UnavailableOverrideTierState = z.object({
  configured: z.string(),
  effective: z.null(),
  source: z.literal("maximal-override"),
  status: z.literal("unavailable"),
  reason: z.literal("override-unavailable"),
})

const UnavailableExternalTierState = z.object({
  configured: z.string().nullable(),
  effective: z.string(),
  source: z.literal("claude-code-setting"),
  status: z.literal("unavailable"),
  reason: z.literal("external-unavailable"),
})

const UnresolvedTierState = z.object({
  configured: z.null(),
  effective: z.null(),
  source: z.literal("none"),
  status: z.literal("unresolved"),
  reason: z.literal("no-match"),
})

export const ClaudeAutoTierState = z.union([
  AutomaticTierState,
  OverrideTierState,
  ExternalTierState,
  UnavailableOverrideTierState,
  UnavailableExternalTierState,
  UnresolvedTierState,
])
export type ClaudeAutoTierState = z.infer<typeof ClaudeAutoTierState>
