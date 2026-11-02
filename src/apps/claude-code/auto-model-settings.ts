import type { ClaudeAutoModelsState } from "~/lib/config/settings-types"
import type {
  ClaudeAutoTier,
  ClaudeAutoTierResolution,
} from "~/lib/models/claude-auto-models"

import { getConfig } from "~/lib/config/config"
import { resolveClaudeAutoModels } from "~/lib/models/claude-auto-models"
import { state } from "~/lib/runtime-state/state"

export const FAST_MODEL_KEY = "ANTHROPIC_DEFAULT_HAIKU_MODEL"
export const CAPABLE_MODEL_KEY = "ANTHROPIC_DEFAULT_SONNET_MODEL"
export const AUTO_MODELS_OWNERSHIP_KEY = "_maximalAutoModels"
export const SETTINGS_UNSET = "__UNSET__"

const ENV_KEY = "env"
const TIER_KEYS = {
  fast: FAST_MODEL_KEY,
  capable: CAPABLE_MODEL_KEY,
} as const

interface AutoModelMarker {
  fast?: string
  capable?: string
}

interface AutoModelContext {
  env: Record<string, unknown>
  marker: AutoModelMarker
  prior: Record<string, unknown>
}

function readEnv(settings: Record<string, unknown>): Record<string, unknown> {
  const env = settings[ENV_KEY]
  if (typeof env === "object" && env !== null && !Array.isArray(env)) {
    return env as Record<string, unknown>
  }
  return {}
}

function readMarker(settings: Record<string, unknown>): AutoModelMarker {
  const raw = settings[AUTO_MODELS_OWNERSHIP_KEY]
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
  const marker = raw as Record<string, unknown>
  return {
    ...(typeof marker.fast === "string" ? { fast: marker.fast } : {}),
    ...(typeof marker.capable === "string" ? { capable: marker.capable } : {}),
  }
}

function stringValue(value: unknown): string | undefined {
  return (
      typeof value === "string"
        && value !== SETTINGS_UNSET
        && value.trim().length > 0
    ) ?
      value
    : undefined
}

function markerOwnsTier(
  context: AutoModelContext,
  tier: ClaudeAutoTier,
): boolean {
  const marked = context.marker[tier]
  return marked !== undefined && context.env[TIER_KEYS[tier]] === marked
}

function externalTierValue(
  context: AutoModelContext,
  tier: ClaudeAutoTier,
): string | undefined {
  const key = TIER_KEYS[tier]
  if (markerOwnsTier(context, tier)) return stringValue(context.prior[key])
  return stringValue(context.env[key])
}

function tierIds(
  fast: string | undefined,
  capable: string | undefined,
): { fast?: string; capable?: string } {
  return {
    ...(fast ? { fast } : {}),
    ...(capable ? { capable } : {}),
  }
}

function resolveForSettings(context: AutoModelContext) {
  const appConfig = getConfig().apps?.claudeCode
  const fastOwned = markerOwnsTier(context, "fast")
  const capableOwned = markerOwnsTier(context, "capable")
  const fastDiverged = context.marker.fast !== undefined && !fastOwned
  const capableDiverged = context.marker.capable !== undefined && !capableOwned
  const fastExternal = externalTierValue(context, "fast")
  const capableExternal = externalTierValue(context, "capable")
  return resolveClaudeAutoModels({
    models: state.models?.data,
    overrides: tierIds(
      fastDiverged ? undefined : appConfig?.fastModel,
      capableDiverged ? undefined : appConfig?.capableModel,
    ),
    external: tierIds(fastExternal, capableExternal),
    previousAutomatic: tierIds(
      fastOwned ? context.marker.fast : undefined,
      capableOwned ? context.marker.capable : undefined,
    ),
  })
}

function snapshotTierIfNeeded(input: {
  context: AutoModelContext
  tier: ClaudeAutoTier
  needed: boolean
}): Record<string, unknown> {
  const key = TIER_KEYS[input.tier]
  if (!input.needed || key in input.context.prior) return input.context.prior
  return {
    ...input.context.prior,
    [key]: key in input.context.env ? input.context.env[key] : SETTINGS_UNSET,
  }
}

function withRestoredField(
  target: Record<string, unknown>,
  key: string,
  prior: unknown,
): Record<string, unknown> {
  if (prior === SETTINGS_UNSET) {
    const { [key]: _dropped, ...without } = target
    return without
  }
  return { ...target, [key]: prior }
}

function applyTier(input: {
  context: AutoModelContext
  outputEnv: Record<string, unknown>
  resolution: ClaudeAutoTierResolution
  tier: ClaudeAutoTier
}): { env: Record<string, unknown>; owned?: string } {
  const key = TIER_KEYS[input.tier]
  if (
    input.resolution.status === "ready"
    && (input.resolution.source === "automatic"
      || input.resolution.source === "maximal-override")
    && input.resolution.effective
  ) {
    return {
      env: { ...input.outputEnv, [key]: input.resolution.effective },
      owned: input.resolution.effective,
    }
  }
  if (markerOwnsTier(input.context, input.tier)) {
    return {
      env: withRestoredField(
        input.outputEnv,
        key,
        input.context.prior[key] ?? SETTINGS_UNSET,
      ),
    }
  }
  return { env: input.outputEnv }
}

export function mergeClaudeAutoModelSettings(input: {
  settings: Record<string, unknown>
  env: Record<string, unknown>
  prior: Record<string, unknown>
}): {
  env: Record<string, unknown>
  marker: AutoModelMarker | null
  prior: Record<string, unknown>
} {
  const context: AutoModelContext = {
    env: readEnv(input.settings),
    marker: readMarker(input.settings),
    prior: input.prior,
  }
  const resolution = resolveForSettings(context)
  context.prior = snapshotTierIfNeeded({
    context,
    tier: "fast",
    needed:
      resolution.fast.source !== "none" || context.marker.fast !== undefined,
  })
  context.prior = snapshotTierIfNeeded({
    context,
    tier: "capable",
    needed:
      resolution.capable.source !== "none"
      || context.marker.capable !== undefined,
  })

  const marker: AutoModelMarker = {}
  const fast = applyTier({
    context,
    outputEnv: input.env,
    resolution: resolution.fast,
    tier: "fast",
  })
  let env = fast.env
  if (fast.owned) marker.fast = fast.owned
  const capable = applyTier({
    context,
    outputEnv: env,
    resolution: resolution.capable,
    tier: "capable",
  })
  env = capable.env
  if (capable.owned) marker.capable = capable.owned

  if (context.marker.fast && !marker.fast && !markerOwnsTier(context, "fast")) {
    marker.fast = context.marker.fast
  }
  if (
    context.marker.capable
    && !marker.capable
    && !markerOwnsTier(context, "capable")
  ) {
    marker.capable = context.marker.capable
  }
  return {
    env,
    marker: marker.fast || marker.capable ? marker : null,
    prior: context.prior,
  }
}

export function stripClaudeAutoModelSettings(input: {
  settings: Record<string, unknown>
  env: Record<string, unknown>
  prior: Record<string, unknown> | null
}): Record<string, unknown> {
  const context: AutoModelContext = {
    env: readEnv(input.settings),
    marker: readMarker(input.settings),
    prior: input.prior ?? {},
  }
  let env = input.env
  for (const tier of ["fast", "capable"] as const) {
    if (markerOwnsTier(context, tier)) {
      const key = TIER_KEYS[tier]
      env = withRestoredField(env, key, context.prior[key] ?? SETTINGS_UNSET)
    }
  }
  return env
}

export function hasOwnedClaudeAutoModelSettings(
  settings: Record<string, unknown>,
): boolean {
  const context: AutoModelContext = {
    env: readEnv(settings),
    marker: readMarker(settings),
    prior: {},
  }
  return markerOwnsTier(context, "fast") || markerOwnsTier(context, "capable")
}

export function buildClaudeAutoModelsState(
  settings: Record<string, unknown>,
  applied: boolean,
): ClaudeAutoModelsState {
  const resolution = resolveForSettings({
    env: readEnv(settings),
    marker: readMarker(settings),
    prior:
      (
        typeof settings._maximalPrior === "object"
        && settings._maximalPrior !== null
        && !Array.isArray(settings._maximalPrior)
      ) ?
        (settings._maximalPrior as Record<string, unknown>)
      : {},
  })
  return {
    applied,
    options: resolution.eligibleModels.map((model) => ({
      id: model.id,
      name: model.name,
      vendor: model.vendor,
      preview: model.preview,
    })),
    fast: resolution.fast,
    capable: resolution.capable,
  }
}
