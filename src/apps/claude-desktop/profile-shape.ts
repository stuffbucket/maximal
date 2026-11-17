/**
 * Pure shape checks on Claude Desktop config-library profiles: what
 * Maximal writes, and which differences can still be Maximal's.
 */

import type { GatewayProfileValues } from "./config"

export function profileMatches(
  existing: Record<string, unknown> | null,
  values: GatewayProfileValues,
): boolean {
  if (!existing) return false
  return (Object.keys(values) as Array<keyof GatewayProfileValues>).every(
    (k) => JSON.stringify(existing[k]) === JSON.stringify(values[k]),
  )
}

/** The gateway shape only we write: a 127.0.0.1 gateway with the
 *  deployment-mode chooser hidden. */
export function isOurGatewayShape(
  profile: Record<string, unknown> | null,
): boolean {
  return (
    profile?.inferenceProvider === "gateway"
    && profile.disableDeploymentModeChooser === true
    && typeof profile.inferenceGatewayBaseUrl === "string"
    && /^http:\/\/127\.0\.0\.1:\d+$/.test(profile.inferenceGatewayBaseUrl)
  )
}

/** The two fields that differ between Maximal copies (port and key). */
const ROUTING_FIELDS: ReadonlySet<string> = new Set([
  "inferenceGatewayBaseUrl",
  "inferenceGatewayApiKey",
])

/** The profile has exactly the fields Maximal writes, no more, no fewer. */
export function hasExactFields(
  profile: Record<string, unknown>,
  values: GatewayProfileValues,
): boolean {
  const keys = Object.keys(values)
  return (
    Object.keys(profile).length === keys.length
    && keys.every((key) => Object.hasOwn(profile, key))
  )
}

/** Exactly the fields Maximal writes, nothing more, every one except the
 *  gateway URL and key equal to this copy's values: a profile any Maximal
 *  copy wrote, whichever copy. Any other edit is the user's. */
export function isMaximalArtifactShape(
  profile: Record<string, unknown> | null,
  values: GatewayProfileValues,
): profile is Record<string, unknown> {
  if (!profile || !isOurGatewayShape(profile)) return false
  if (!hasExactFields(profile, values)) return false
  if (
    typeof profile.inferenceGatewayApiKey !== "string"
    || profile.inferenceGatewayApiKey === ""
  ) {
    return false
  }
  const keys = Object.keys(values) as Array<keyof GatewayProfileValues>
  return keys.every(
    (key) =>
      ROUTING_FIELDS.has(key)
      || JSON.stringify(profile[key]) === JSON.stringify(values[key]),
  )
}

export function routingPair(profile: {
  inferenceGatewayBaseUrl?: unknown
  inferenceGatewayApiKey?: unknown
}): string {
  return JSON.stringify([
    profile.inferenceGatewayBaseUrl,
    profile.inferenceGatewayApiKey,
  ])
}
