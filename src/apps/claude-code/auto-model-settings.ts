import type { ClaudeAutoModelsState } from "~/lib/config/settings-types"
import type { ClaudeAutoTierState } from "~/lib/models/claude-auto-model-types"
import type { ClaudeAutoTier } from "~/lib/models/claude-auto-models"

import { getConfig } from "~/lib/config/config"
import { resolveClaudeAutoModels } from "~/lib/models/claude-auto-models"
import { state } from "~/lib/runtime-state/state"

import {
  priorField,
  readSettingsEnv,
  SETTINGS_UNSET,
  withRestoredField,
} from "./settings-record"

export const FAST_MODEL_KEY = "ANTHROPIC_DEFAULT_HAIKU_MODEL"
export const CAPABLE_MODEL_KEY = "ANTHROPIC_DEFAULT_SONNET_MODEL"
export const AUTO_MODELS_OWNERSHIP_KEY = "_maximalAutoModels"

const TIER_KEYS = {
  fast: FAST_MODEL_KEY,
  capable: CAPABLE_MODEL_KEY,
} as const

type OwnedSource = "automatic" | "maximal-override"

interface AutoModelMarkerEntry {
  id: string
  source: OwnedSource
  claimed?: boolean
}

interface AutoModelMarker {
  fast?: AutoModelMarkerEntry
  capable?: AutoModelMarkerEntry
}

type TierOwnership =
  | { kind: "owned"; marker: AutoModelMarkerEntry }
  | { kind: "external-value"; value: string; diverged: boolean }
  | { kind: "external-absent"; diverged: boolean }
  | { kind: "unmanaged" }

interface AutoModelContext {
  env: Record<string, unknown>
  marker: AutoModelMarker
  prior: Record<string, unknown>
}

function readMarker(settings: Record<string, unknown>): AutoModelMarker {
  const raw = settings[AUTO_MODELS_OWNERSHIP_KEY]
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
  const record = raw as Record<string, unknown>
  const readEntry = (
    tier: ClaudeAutoTier,
  ): AutoModelMarkerEntry | undefined => {
    const value = record[tier]
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined
    }
    const entry = value as Record<string, unknown>
    if (
      typeof entry.id !== "string"
      || (entry.source !== "automatic" && entry.source !== "maximal-override")
    ) {
      return undefined
    }
    return {
      id: entry.id,
      source: entry.source,
      ...(entry.claimed === true ? { claimed: true } : {}),
    }
  }
  return {
    ...(readEntry("fast") ? { fast: readEntry("fast") } : {}),
    ...(readEntry("capable") ? { capable: readEntry("capable") } : {}),
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

function changedFromPrior(context: AutoModelContext, key: string): boolean {
  if (!(key in context.prior)) return false
  const prior = context.prior[key]
  if (prior === SETTINGS_UNSET) return key in context.env
  return !(key in context.env) || !Object.is(context.env[key], prior)
}

function ownershipForTier(
  context: AutoModelContext,
  tier: ClaudeAutoTier,
): TierOwnership {
  const key = TIER_KEYS[tier]
  const current = stringValue(context.env[key])
  const marker = context.marker[tier]
  if (marker && current === marker.id) return { kind: "owned", marker }
  const diverged = Boolean(marker) || changedFromPrior(context, key)
  if (current) return { kind: "external-value", value: current, diverged }
  if (marker || key in context.env || diverged) {
    return { kind: "external-absent", diverged }
  }
  return { kind: "unmanaged" }
}

function priorOwnership(
  context: AutoModelContext,
  tier: ClaudeAutoTier,
): TierOwnership | null {
  const key = TIER_KEYS[tier]
  if (!(key in context.prior) || context.prior[key] === SETTINGS_UNSET) {
    return null
  }
  const value = stringValue(context.prior[key])
  return value ?
      { kind: "external-value", value, diverged: false }
    : { kind: "external-absent", diverged: false }
}

function externalId(ownership: TierOwnership): string | undefined {
  return ownership.kind === "external-value" ? ownership.value : undefined
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

function configuredState(
  state: ClaudeAutoTierState,
  configured: string | undefined,
): ClaudeAutoTierState {
  if (state.source !== "claude-code-setting" || !configured) return state
  return { ...state, configured }
}

function externalAbsentState(configured?: string): ClaudeAutoTierState {
  return {
    configured: configured ?? null,
    effective: null,
    source: "claude-code-setting",
    status: "ready",
    reason: "external-setting",
  }
}

function canOwnTier(ownership: TierOwnership, claimed: boolean): boolean {
  if (claimed) return true
  if (
    ownership.kind === "external-value"
    || ownership.kind === "external-absent"
  ) {
    return !ownership.diverged
  }
  return true
}

interface TierPolicyInput {
  configured?: string
  external?: string
  externalAbsent: boolean
  override?: string
  previousAutomatic?: string
}

function resolveEffectiveOwnership(
  context: AutoModelContext,
  tier: ClaudeAutoTier,
  ownership: TierOwnership,
): TierOwnership {
  if (ownership.kind !== "owned" || ownership.marker.claimed) {
    return ownership.kind === "owned" ? { kind: "unmanaged" } : ownership
  }
  return priorOwnership(context, tier) ?? { kind: "unmanaged" }
}

function tierPolicyInput(
  context: AutoModelContext,
  tier: ClaudeAutoTier,
  claims: ReadonlySet<ClaudeAutoTier>,
): TierPolicyInput {
  const ownership = ownershipForTier(context, tier)
  const effective = resolveEffectiveOwnership(context, tier, ownership)
  const claimed = claims.has(tier)
  const appConfig = getConfig().apps?.claudeCode
  const configured =
    tier === "fast" ? appConfig?.fastModel : appConfig?.capableModel
  return {
    configured,
    override: canOwnTier(ownership, claimed) ? configured : undefined,
    external: claimed ? undefined : externalId(effective),
    externalAbsent: !claimed && effective.kind === "external-absent",
    previousAutomatic:
      ownership.kind === "owned" && ownership.marker.source === "automatic" ?
        ownership.marker.id
      : undefined,
  }
}

function resolvedTierState(
  state: ClaudeAutoTierState,
  policy: TierPolicyInput,
): ClaudeAutoTierState {
  return policy.externalAbsent ?
      externalAbsentState(policy.configured)
    : configuredState(state, policy.configured)
}

function resolveForSettings(
  context: AutoModelContext,
  claims: ReadonlySet<ClaudeAutoTier> = new Set(),
) {
  const fastPolicy = tierPolicyInput(context, "fast", claims)
  const capablePolicy = tierPolicyInput(context, "capable", claims)
  const resolution = resolveClaudeAutoModels({
    models: state.models?.data,
    overrides: tierIds(fastPolicy.override, capablePolicy.override),
    external: tierIds(fastPolicy.external, capablePolicy.external),
    previousAutomatic: tierIds(
      fastPolicy.previousAutomatic,
      capablePolicy.previousAutomatic,
    ),
  })
  return {
    ...resolution,
    fast: resolvedTierState(resolution.fast, fastPolicy),
    capable: resolvedTierState(resolution.capable, capablePolicy),
  }
}

function snapshotClaim(context: AutoModelContext, tier: ClaudeAutoTier): void {
  const ownership = ownershipForTier(context, tier)
  if (
    ownership.kind !== "external-value"
    && ownership.kind !== "external-absent"
  ) {
    return
  }
  const key = TIER_KEYS[tier]
  context.prior = {
    ...context.prior,
    [key]: key in context.env ? context.env[key] : SETTINGS_UNSET,
  }
  context.marker = { ...context.marker, [tier]: undefined }
}

function snapshotTierIfNeeded(input: {
  context: AutoModelContext
  tier: ClaudeAutoTier
  needed: boolean
}): void {
  const key = TIER_KEYS[input.tier]
  if (!input.needed || key in input.context.prior) return
  input.context.prior = {
    ...input.context.prior,
    [key]: key in input.context.env ? input.context.env[key] : SETTINGS_UNSET,
  }
}

function applyTier(input: {
  claimed: boolean
  context: AutoModelContext
  outputEnv: Record<string, unknown>
  resolution: ClaudeAutoTierState
  tier: ClaudeAutoTier
}): { env: Record<string, unknown>; marker?: AutoModelMarkerEntry } {
  const key = TIER_KEYS[input.tier]
  const ownership = ownershipForTier(input.context, input.tier)
  const claimed =
    input.claimed
    || (ownership.kind === "owned" && ownership.marker.claimed === true)
  if (
    input.resolution.status === "ready"
    && (input.resolution.source === "automatic"
      || input.resolution.source === "maximal-override")
    && input.resolution.effective
  ) {
    return {
      env: { ...input.outputEnv, [key]: input.resolution.effective },
      marker: {
        id: input.resolution.effective,
        source: input.resolution.source,
        ...(claimed ? { claimed: true } : {}),
      },
    }
  }
  if (
    input.resolution.status === "unavailable"
    && input.resolution.source === "maximal-override"
    && ownership.kind === "owned"
    && ownership.marker.source === "maximal-override"
    && ownership.marker.id === input.resolution.configured
  ) {
    return { env: input.outputEnv, marker: ownership.marker }
  }
  if (ownership.kind === "owned") {
    return {
      env: withRestoredField(
        input.outputEnv,
        key,
        priorField(input.context.prior, key),
      ),
    }
  }
  return { env: input.outputEnv }
}

export function mergeClaudeAutoModelSettings(input: {
  settings: Record<string, unknown>
  env: Record<string, unknown>
  prior: Record<string, unknown>
  claimTiers?: ReadonlySet<ClaudeAutoTier>
}): {
  env: Record<string, unknown>
  marker: AutoModelMarker | null
  prior: Record<string, unknown>
} {
  const context: AutoModelContext = {
    env: readSettingsEnv(input.settings),
    marker: readMarker(input.settings),
    prior: input.prior,
  }
  const claims = input.claimTiers ?? new Set<ClaudeAutoTier>()
  for (const tier of claims) snapshotClaim(context, tier)
  const resolution = resolveForSettings(context, claims)
  snapshotTierIfNeeded({
    context,
    tier: "fast",
    needed:
      resolution.fast.source !== "none" || context.marker.fast !== undefined,
  })
  snapshotTierIfNeeded({
    context,
    tier: "capable",
    needed:
      resolution.capable.source !== "none"
      || context.marker.capable !== undefined,
  })

  const marker: AutoModelMarker = {}
  const fast = applyTier({
    claimed: claims.has("fast"),
    context,
    outputEnv: input.env,
    resolution: resolution.fast,
    tier: "fast",
  })
  let env = fast.env
  if (fast.marker) marker.fast = fast.marker
  const capable = applyTier({
    claimed: claims.has("capable"),
    context,
    outputEnv: env,
    resolution: resolution.capable,
    tier: "capable",
  })
  env = capable.env
  if (capable.marker) marker.capable = capable.marker

  for (const tier of ["fast", "capable"] as const) {
    const ownership = ownershipForTier(context, tier)
    if (
      !marker[tier]
      && (ownership.kind === "external-value"
        || ownership.kind === "external-absent")
      && ownership.diverged
      && context.marker[tier]
    ) {
      marker[tier] = context.marker[tier]
    }
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
    env: readSettingsEnv(input.settings),
    marker: readMarker(input.settings),
    prior: input.prior ?? {},
  }
  let env = input.env
  for (const tier of ["fast", "capable"] as const) {
    if (ownershipForTier(context, tier).kind === "owned") {
      const key = TIER_KEYS[tier]
      env = withRestoredField(env, key, priorField(context.prior, key))
    }
  }
  return env
}

export function hasOwnedClaudeAutoModelSettings(
  settings: Record<string, unknown>,
): boolean {
  const context: AutoModelContext = {
    env: readSettingsEnv(settings),
    marker: readMarker(settings),
    prior: {},
  }
  return (
    ownershipForTier(context, "fast").kind === "owned"
    || ownershipForTier(context, "capable").kind === "owned"
  )
}

export function buildClaudeAutoModelsState(
  settings: Record<string, unknown>,
  prior: Record<string, unknown> | null,
  applied: boolean,
): ClaudeAutoModelsState {
  const resolution = resolveForSettings({
    env: readSettingsEnv(settings),
    marker: readMarker(settings),
    prior: prior ?? {},
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
