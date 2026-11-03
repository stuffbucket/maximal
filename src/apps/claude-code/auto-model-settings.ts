import type { ClaudeAutoModelsState } from "~/lib/config/settings-types"
import type { ClaudeAutoTierState } from "~/lib/models/claude-auto-model-types"
import type { ClaudeAutoTier } from "~/lib/models/claude-auto-models"

import { getConfig } from "~/lib/config/config"
import {
  isClaudeCodeClassifierEligible,
  resolveClaudeAutoModels,
} from "~/lib/models/claude-auto-models"
import { resolveModelMapping } from "~/lib/models/model-mapping"
import { state } from "~/lib/runtime-state/state"

import {
  priorField,
  readSettingsEnv,
  SETTINGS_UNSET,
  withRestoredField,
} from "./settings-record"

export const FAST_MODEL_KEY = "ANTHROPIC_DEFAULT_HAIKU_MODEL"
export const CAPABLE_MODEL_KEY = "ANTHROPIC_DEFAULT_SONNET_MODEL"
export const CLASSIFIER_MODEL_KEY = "CLAUDE_CODE_AUTO_MODE_MODEL"
export const UNAVAILABLE_CLASSIFIER_MODEL =
  "claude-maximal-auto-mode-unavailable"
export const AUTO_MODELS_OWNERSHIP_KEY = "_maximalAutoModels"
export const AUTO_MODELS_JOURNAL_KEY = "_maximalAutoModelsJournal"

const AUTO_MODELS_JOURNAL_VERSION = 1
const AUTO_MODEL_TIERS = ["fast", "capable", "classifier"] as const

const TIER_KEYS = {
  fast: FAST_MODEL_KEY,
  capable: CAPABLE_MODEL_KEY,
  classifier: CLASSIFIER_MODEL_KEY,
} as const

const CONFIG_KEYS = {
  fast: "fastModel",
  capable: "capableModel",
  classifier: "classifierModel",
} as const

type OwnedSource = "automatic" | "maximal-override"

interface AutoModelMarkerEntry {
  id: string
  source: OwnedSource
  claimed?: boolean
  diverged?: boolean
  suspended?: boolean
}

interface AutoModelMarker {
  fast?: AutoModelMarkerEntry
  capable?: AutoModelMarkerEntry
  classifier?: AutoModelMarkerEntry
}

interface AutoModelJournalTier {
  marker: AutoModelMarkerEntry
  ownership: "owned" | "external"
  prior: unknown
}

interface AutoModelJournal {
  version: typeof AUTO_MODELS_JOURNAL_VERSION
  tiers: Partial<Record<ClaudeAutoTier, AutoModelJournalTier>>
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
  sessionModel?: string
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
      ...(entry.diverged === true ? { diverged: true } : {}),
      ...(entry.suspended === true ? { suspended: true } : {}),
    }
  }
  const marker: AutoModelMarker = {}
  for (const tier of AUTO_MODEL_TIERS) {
    const entry = readEntry(tier)
    if (entry) marker[tier] = entry
  }
  return marker
}

function readJournalTier(
  raw: unknown,
  tier: ClaudeAutoTier,
): AutoModelJournalTier | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return
  const entry = raw as Record<string, unknown>
  const marker = readMarker({
    [AUTO_MODELS_OWNERSHIP_KEY]: { [tier]: entry.marker },
  })[tier]
  if (
    !marker
    || (entry.ownership !== "owned" && entry.ownership !== "external")
    || !("prior" in entry)
  ) {
    return
  }
  return { marker, ownership: entry.ownership, prior: entry.prior }
}

function readJournal(raw: unknown): AutoModelJournal | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (
    record.version !== AUTO_MODELS_JOURNAL_VERSION
    || typeof record.tiers !== "object"
    || record.tiers === null
    || Array.isArray(record.tiers)
  ) {
    return null
  }
  const rawTiers = record.tiers as Record<string, unknown>
  const tiers: AutoModelJournal["tiers"] = {}
  for (const tier of AUTO_MODEL_TIERS) {
    const entry = readJournalTier(rawTiers[tier], tier)
    if (entry) tiers[tier] = entry
  }
  return AUTO_MODEL_TIERS.some((tier) => tiers[tier]) ?
      { version: AUTO_MODELS_JOURNAL_VERSION, tiers }
    : null
}

export function isUnsupportedClaudeAutoModelJournal(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return false
  }
  const version = (raw as Record<string, unknown>).version
  return typeof version === "number" && version !== AUTO_MODELS_JOURNAL_VERSION
}

function fieldMatchesSnapshot(
  record: Record<string, unknown>,
  key: string,
  snapshot: unknown,
): boolean {
  if (snapshot === SETTINGS_UNSET) return !(key in record)
  return key in record && Object.is(record[key], snapshot)
}

function readSessionModel(
  settings: Record<string, unknown>,
): string | undefined {
  const envModel = readSettingsEnv(settings).ANTHROPIC_MODEL
  if (typeof envModel === "string" && envModel.trim()) return envModel.trim()
  const model = settings.model
  return typeof model === "string" && model.trim() ? model.trim() : undefined
}

function mappedSessionModel(
  sessionModel: string | undefined,
): string | undefined {
  if (!sessionModel) return undefined
  const mapping = resolveModelMapping({
    requestedModel: sessionModel.replace(/\[1m\]$/u, ""),
    rules: getConfig().modelMappings ?? [],
    models: state.models?.data ?? [],
    endpoint: null,
  })
  return mapping.resolvedModel
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
  const changed = changedFromPrior(context, key)
  if (
    marker
    && !marker.diverged
    && (marker.suspended ? !changed : current === marker.id)
  ) {
    return { kind: "owned", marker }
  }
  const diverged = Boolean(marker) || changed
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
  classifier: string | undefined,
): { fast?: string; capable?: string; classifier?: string } {
  return {
    ...(fast ? { fast } : {}),
    ...(capable ? { capable } : {}),
    ...(classifier ? { classifier } : {}),
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
  const configured = appConfig?.[CONFIG_KEYS[tier]]
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
  const classifierPolicy = tierPolicyInput(context, "classifier", claims)
  const resolution = resolveClaudeAutoModels({
    models: state.models?.data,
    overrides: tierIds(
      fastPolicy.override,
      capablePolicy.override,
      classifierPolicy.override,
    ),
    external: tierIds(
      fastPolicy.external,
      capablePolicy.external,
      classifierPolicy.external,
    ),
    previousAutomatic: tierIds(
      fastPolicy.previousAutomatic,
      capablePolicy.previousAutomatic,
      classifierPolicy.previousAutomatic,
    ),
    sessionModel: mappedSessionModel(context.sessionModel),
  })
  return {
    ...resolution,
    fast: resolvedTierState(resolution.fast, fastPolicy),
    capable: resolvedTierState(resolution.capable, capablePolicy),
    classifier: resolvedTierState(resolution.classifier, classifierPolicy),
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

function automaticMarkerDuringGap(
  tier: ClaudeAutoTier,
  resolution: ClaudeAutoTierState,
  ownership: TierOwnership,
): { keepApplied: boolean; marker: AutoModelMarkerEntry } | undefined {
  if (
    resolution.status !== "unresolved"
    || ownership.kind !== "owned"
    || ownership.marker.source !== "automatic"
  ) {
    return undefined
  }
  if (tier !== "classifier") {
    return {
      keepApplied: false,
      marker: { ...ownership.marker, suspended: true },
    }
  }
  const previous = state.models?.data.find(
    (model) => model.id === ownership.marker.id,
  )
  if (previous && !isClaudeCodeClassifierEligible(previous)) {
    return {
      keepApplied: true,
      marker: {
        id: UNAVAILABLE_CLASSIFIER_MODEL,
        source: "automatic",
        ...(ownership.marker.claimed ? { claimed: true } : {}),
      },
    }
  }
  return { keepApplied: true, marker: ownership.marker }
}

function needsUnavailableClassifier(input: {
  claimed: boolean
  resolution: ClaudeAutoTierState
  tier: ClaudeAutoTier
}): boolean {
  return (
    input.claimed
    && input.tier === "classifier"
    && input.resolution.status === "unresolved"
  )
}

function applyAutomaticMarkerDuringGap(input: {
  automaticMarker: { keepApplied: boolean; marker: AutoModelMarkerEntry }
  context: AutoModelContext
  key: string
  outputEnv: Record<string, unknown>
}): { env: Record<string, unknown>; marker: AutoModelMarkerEntry } {
  if (input.automaticMarker.keepApplied) {
    return {
      env: {
        ...input.outputEnv,
        [input.key]: input.automaticMarker.marker.id,
      },
      marker: input.automaticMarker.marker,
    }
  }
  return {
    env: withRestoredField(
      input.outputEnv,
      input.key,
      priorField(input.context.prior, input.key),
    ),
    marker: input.automaticMarker.marker,
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
  if (needsUnavailableClassifier(input)) {
    return {
      env: {
        ...input.outputEnv,
        [key]: UNAVAILABLE_CLASSIFIER_MODEL,
      },
      marker: {
        id: UNAVAILABLE_CLASSIFIER_MODEL,
        source: "automatic",
        claimed: true,
      },
    }
  }
  const automaticMarker = automaticMarkerDuringGap(
    input.tier,
    input.resolution,
    ownership,
  )
  if (automaticMarker) {
    // Alias mappings restore their prior values during a gap but retain a
    // suspended marker for the next catalog. The classifier stays pinned so it
    // fails closed; an incompatible cataloged model becomes the sentinel.
    return applyAutomaticMarkerDuringGap({
      automaticMarker,
      context: input.context,
      key,
      outputEnv: input.outputEnv,
    })
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

export function suspendClaudeAutoModelSettings(input: {
  settings: Record<string, unknown>
  prior: Record<string, unknown> | null
}): Record<string, unknown> | null {
  const context: AutoModelContext = {
    env: readSettingsEnv(input.settings),
    marker: readMarker(input.settings),
    prior: input.prior ?? {},
    sessionModel: readSessionModel(input.settings),
  }
  const tiers: AutoModelJournal["tiers"] = {}
  for (const tier of AUTO_MODEL_TIERS) {
    const marker = context.marker[tier]
    if (!marker) continue
    const ownership = ownershipForTier(context, tier)
    tiers[tier] = {
      marker,
      ownership: ownership.kind === "owned" ? "owned" : "external",
      prior: priorField(context.prior, TIER_KEYS[tier]),
    }
  }
  return AUTO_MODEL_TIERS.some((tier) => tiers[tier]) ?
      { version: AUTO_MODELS_JOURNAL_VERSION, tiers }
    : null
}

export function resumeClaudeAutoModelSettings(input: {
  env: Record<string, unknown>
  journal: unknown
}): {
  env: Record<string, unknown>
  marker: unknown
  prior: Record<string, unknown>
} | null {
  const journal = readJournal(input.journal)
  if (!journal) return null
  let env = input.env
  const marker: AutoModelMarker = {}
  const prior: Record<string, unknown> = {}
  for (const tier of AUTO_MODEL_TIERS) {
    const suspended = journal.tiers[tier]
    if (!suspended) continue
    const key = TIER_KEYS[tier]
    const resumesOwnership =
      suspended.ownership === "owned"
      && fieldMatchesSnapshot(env, key, suspended.prior)
    marker[tier] =
      resumesOwnership ?
        suspended.marker
      : { ...suspended.marker, diverged: true }
    prior[key] = suspended.prior
    if (resumesOwnership && !suspended.marker.suspended) {
      env = { ...env, [key]: suspended.marker.id }
    }
  }
  return { env, marker, prior }
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
    sessionModel: readSessionModel(input.settings),
  }
  const claims = input.claimTiers ?? new Set<ClaudeAutoTier>()
  for (const tier of claims) snapshotClaim(context, tier)
  const resolution = resolveForSettings(context, claims)
  for (const tier of AUTO_MODEL_TIERS) {
    snapshotTierIfNeeded({
      context,
      tier,
      needed:
        resolution[tier].source !== "none"
        || context.marker[tier] !== undefined,
    })
  }

  const marker: AutoModelMarker = {}
  let env = input.env
  for (const tier of AUTO_MODEL_TIERS) {
    const applied = applyTier({
      claimed: claims.has(tier),
      context,
      outputEnv: env,
      resolution: resolution[tier],
      tier,
    })
    env = applied.env
    if (applied.marker) marker[tier] = applied.marker
  }

  for (const tier of AUTO_MODEL_TIERS) {
    const ownership = ownershipForTier(context, tier)
    if (
      !marker[tier]
      && (ownership.kind === "external-value"
        || ownership.kind === "external-absent")
      && ownership.diverged
      && context.marker[tier]
    ) {
      marker[tier] = { ...context.marker[tier], diverged: true }
    }
  }
  return {
    env,
    marker: AUTO_MODEL_TIERS.some((tier) => marker[tier]) ? marker : null,
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
    sessionModel: readSessionModel(input.settings),
  }
  let env = input.env
  for (const tier of AUTO_MODEL_TIERS) {
    if (ownershipForTier(context, tier).kind === "owned") {
      const key = TIER_KEYS[tier]
      env = withRestoredField(env, key, priorField(context.prior, key))
    }
  }
  return env
}

export function hasClaudeAutoModelMarker(
  settings: Record<string, unknown>,
): boolean {
  const marker = readMarker(settings)
  return AUTO_MODEL_TIERS.some((tier) => marker[tier])
}

export function hasOwnedClaudeAutoModelSettings(
  settings: Record<string, unknown>,
): boolean {
  const context: AutoModelContext = {
    env: readSettingsEnv(settings),
    marker: readMarker(settings),
    prior: {},
    sessionModel: readSessionModel(settings),
  }
  return AUTO_MODEL_TIERS.some(
    (tier) => ownershipForTier(context, tier).kind === "owned",
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
    sessionModel: readSessionModel(settings),
  })
  return {
    applied,
    options: resolution.eligibleModels.map((model) => ({
      id: model.id,
      name: model.name,
      vendor: model.vendor,
      preview: model.preview,
    })),
    classifier_options: resolution.classifierEligibleModels.map((model) => ({
      id: model.id,
      name: model.name,
      vendor: model.vendor,
      preview: model.preview,
    })),
    fast: resolution.fast,
    capable: resolution.capable,
    classifier: resolution.classifier,
  }
}
