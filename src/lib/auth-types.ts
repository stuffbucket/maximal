/**
 * Typed value space for the auth/account domain (boundary D1).
 *
 * These types close the value space so invalid auth/account values are
 * unrepresentable rather than caught at runtime:
 *   - `AccountType` is a closed enum, not a free string interpolated into a
 *     hostname (a typo like "enterpise" can no longer silently produce
 *     `https://api.enterpise.githubcopilot.com`).
 *   - `CopilotHost` is a branded, validated https origin — the only way to
 *     obtain one is through `toCopilotHost`/`hostForAccountType`, so a raw
 *     unvalidated string can't reach the completion-host slot.
 *
 * Forward note: Phase 2 introduces an `AuthState` discriminated union that
 * embeds these types (`plan: AccountType`, `host: CopilotHost`); they are
 * defined here so both phases share one source of truth.
 */
import { z } from "zod"

export const ACCOUNT_TYPES = ["individual", "business", "enterprise"] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

export const accountTypeSchema = z.enum(ACCOUNT_TYPES)

/** Parse an external string (CLI flag, env) into an AccountType, or throw a
 *  clear message naming the valid values. Fail closed — a bad value must not
 *  fall through to a constructed-but-wrong host. */
export function parseAccountType(input: string): AccountType {
  const result = accountTypeSchema.safeParse(input)
  if (!result.success) {
    throw new Error(
      `Invalid account type "${input}". Must be one of: ${ACCOUNT_TYPES.join(", ")}.`,
    )
  }
  return result.data
}

declare const copilotHostBrand: unique symbol
/** A validated https Copilot API origin (scheme + host, no path/trailing
 *  slash). Construct only via `toCopilotHost` or `hostForAccountType`. */
export type CopilotHost = string & { readonly [copilotHostBrand]: true }

/** Validate + normalize a URL into a CopilotHost, or `null` if it isn't a
 *  well-formed https URL. Normalizes to the origin so trailing slashes /
 *  stray paths can't produce two "different" hosts for the same server. */
export function toCopilotHost(url: string): CopilotHost | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== "https:") return null
  return parsed.origin as CopilotHost
}

/**
 * The default completion host for an account type, used only before
 * discovery (`/copilot_internal/v2/token`'s `endpoints.api`) populates the
 * authoritative host. `individual` is served from the apex host —
 * `api.individual.githubcopilot.com` returns 421 Misdirected, so the apex is
 * correct there; business/enterprise get a subdomain. Built from the closed
 * enum, so the result is always a valid host.
 */
export function hostForAccountType(accountType: AccountType): CopilotHost {
  const url =
    accountType === "individual" ?
      "https://api.githubcopilot.com"
    : `https://api.${accountType}.githubcopilot.com`
  return url as CopilotHost
}
