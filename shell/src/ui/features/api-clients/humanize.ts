/**
 * Translate the proxy's structured `{error: {message, type}}` envelope
 * into a single human-readable string. The shell renders this directly
 * in a `.state__caption--error` paragraph, so we MUST NOT leak the raw
 * JSON envelope to the user.
 *
 * Strategy: try to parse the raw text as JSON; if it matches the
 * envelope shape, surface only `.error.message`. Otherwise pass the
 * raw text through (truncated at a reasonable cap so a giant HTML
 * 500-page doesn't blow up the layout).
 */
const MAX_RAW_LEN = 280;

export function humanize(raw: string | undefined | null): string {
  if (!raw) return "Something went wrong.";
  const trimmed = raw.trim();
  if (!trimmed) return "Something went wrong.";

  // Most proxy errors come back as JSON. parse() lazily, swallow.
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error: unknown }).error === "object" &&
      (parsed as { error: { message?: unknown } }).error !== null
    ) {
      const inner = (parsed as { error: { message?: unknown } }).error;
      if (typeof inner.message === "string" && inner.message.length > 0) {
        return inner.message;
      }
    }
  } catch {
    /* not JSON — fall through to raw */
  }

  if (trimmed.length > MAX_RAW_LEN) {
    return `${trimmed.slice(0, MAX_RAW_LEN)}…`;
  }
  return trimmed;
}
