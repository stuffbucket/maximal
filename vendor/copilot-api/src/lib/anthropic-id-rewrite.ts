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
