/**
 * Rewrites Anthropic-family Copilot model IDs to a canonical dash-date form
 * so Claude Desktop's regex-based normalizer preserves minor version + suffix
 * detail in its model picker.
 *
 * Copilot returns IDs like `claude-opus-4.6` or `claude-opus-4.7-high`.
 * Claude Desktop's normalizer collapses these all to "Opus 4". By rewriting
 * the dot to a dash and appending a stable date sentinel, the IDs match the
 * shape of Anthropic's canonical IDs (`claude-opus-4-1-20250805`) and the
 * normalizer keeps the version distinct.
 *
 * Non-Anthropic IDs (gpt-*, gemini-*, embedding-*) pass through untouched.
 */

const SENTINEL_DATE = "20260301"

const FORWARD_RE = /^claude-(opus|sonnet|haiku)-(\d+)\.(\d+)(?:-(.*))?$/
const REVERSE_RE = new RegExp(
  `^claude-(opus|sonnet|haiku)-(\\d+)-(\\d+)(?:-(.*))?-${SENTINEL_DATE}$`,
)

/**
 * Convert a Copilot model ID into the canonical dash-date form.
 *
 * Examples:
 * - `claude-opus-4.6` -> `claude-opus-4-6-20260301`
 * - `claude-opus-4.7-high` -> `claude-opus-4-7-high-20260301`
 * - `claude-opus-4.7-1m-internal` -> `claude-opus-4-7-1m-internal-20260301`
 * - `gpt-5.2` -> `gpt-5.2` (unchanged)
 */
export function forwardId(copilotId: string): string {
  const match = FORWARD_RE.exec(copilotId)
  if (!match) {
    return copilotId
  }
  const [, family, major, minor, suffix] = match
  const suffixPart = suffix ? `-${suffix}` : ""
  return `claude-${family}-${major}-${minor}${suffixPart}-${SENTINEL_DATE}`
}

/**
 * Convert a (possibly rewritten) ID back to Copilot's original dot-form.
 * Accepts either form: an already-Copilot ID returns unchanged.
 *
 * Examples:
 * - `claude-opus-4-6-20260301` -> `claude-opus-4.6`
 * - `claude-opus-4-7-high-20260301` -> `claude-opus-4.7-high`
 * - `claude-opus-4.6` -> `claude-opus-4.6` (unchanged)
 * - `gpt-5.2` -> `gpt-5.2` (unchanged)
 */
export function reverseId(anthropicId: string): string {
  const match = REVERSE_RE.exec(anthropicId)
  if (!match) {
    return anthropicId
  }
  const [, family, major, minor, suffix] = match
  const suffixPart = suffix ? `-${suffix}` : ""
  return `claude-${family}-${major}.${minor}${suffixPart}`
}

// Copilot encodes effort/context variants as id suffixes (`-high`,
// `-xhigh`, `-1m`, `-1m-internal`). Anthropic exposes the same as
// request-time parameters (`output_config.effort`, the
// `anthropic-beta: context-1m-...` header). The proxy hides variant
// ids from /v1/models and routes the request to the right upstream
// variant when those parameters are set on the inbound request.
const VARIANT_RE = /-(?:low|medium|high|xhigh|max|1m)(?:-internal)?$/

export function isVariantId(copilotId: string): boolean {
  if (!FORWARD_RE.test(copilotId)) return false
  return VARIANT_RE.test(copilotId)
}

export interface VariantOpts {
  effort?: "low" | "medium" | "high" | "xhigh" | "max"
  longContext?: boolean
}

/**
 * Given a base Copilot id (`claude-opus-4.7`) plus request-time variant
 * parameters, return the most specific upstream id that exists in the
 * known list. Falls back to the base id when no variant matches.
 */
export function pickCopilotVariantId(
  baseId: string,
  opts: VariantOpts,
  knownIds: ReadonlyArray<string>,
): string {
  if (isVariantId(baseId)) return baseId
  if (!FORWARD_RE.test(baseId)) return baseId

  const candidates: Array<string> = []
  if (opts.effort && opts.effort !== "low" && opts.effort !== "medium") {
    candidates.push(`${baseId}-${opts.effort}`)
  }
  if (opts.longContext) {
    candidates.push(`${baseId}-1m-internal`, `${baseId}-1m`)
  }
  for (const candidate of candidates) {
    if (knownIds.includes(candidate)) return candidate
  }
  return baseId
}
