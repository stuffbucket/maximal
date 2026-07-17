/**
 * Fail-closed redaction for handler logs.
 *
 * The daily handler logs are a debugging aid: they should capture the
 * *shape, structure, and configuration* of a request/response — model,
 * roles, block types, tool names, token counts, stop reasons — and never
 * the *content* (prompt text, tool inputs/outputs, image bytes, model
 * output). Content is PII (user code, file contents, conversations) and
 * has no place on disk.
 *
 * Policy is **redact-by-default** (fail-closed): we keep an allowlist of
 * structural keys whose string values are safe to log verbatim, and
 * every other string leaf is replaced with a length-preserving marker
 * (`[redacted N chars]`). A field we've never seen — including one a
 * future API version introduces — defaults to redacted, so new content
 * can't leak before we notice it.
 *
 * Numbers, booleans, and null are kept: they're almost always structural
 * or config (max_tokens, temperature, usage counts, stream flags) and
 * carry negligible PII while being the most useful values for debugging
 * payload shape. Object *keys* are always preserved (they describe the
 * schema, e.g. a tool's parameter names); only string *values* are
 * subject to redaction.
 */

/**
 * String-valued keys safe to log verbatim. These describe the structure
 * or configuration of a message exchange, not its content. Matched
 * case-insensitively. When a string value sits under one of these keys
 * (or inside an array under one of these keys) it is kept; every other
 * string is redacted.
 */
const STRUCTURAL_STRING_KEYS: ReadonlySet<string> = new Set(
  [
    // Routing / model identity
    "model",
    "object",
    "provider",
    "kind",
    "status",
    "source",
    "service_tier",
    "encoding",
    // Message / block structure
    "role",
    "type",
    "name", // tool names, block names — definitions, not content
    "tool_name",
    "function_name",
    // Termination / outcome
    "stop_reason",
    "finish_reason",
    "stop", // OpenAI stop-sequence marker echoes (sequences themselves redacted)
    // Identifiers / protocol versions
    "id",
    "request_id",
    "session_id",
    "trace_id",
    "tool_use_id",
    "tool_call_id",
    "anthropic_version",
    "anthropic_beta",
    "version",
    "schema_version",
    // Media descriptors (the bytes/data live under other keys and are redacted)
    "media_type",
    "mime_type",
    "detail",
    // Reasoning / effort configuration
    "reasoning_effort",
    "effort",
    "authtype",
    // Transport/socket error diagnostics. These keys only ever carry
    // structural network-error values (the failing syscall, the resolver
    // host, a socket peer address/port) — never request/response content — so
    // they're safe to surface for auth/network debugging. `code` and `path`
    // are deliberately NOT here: they collide with content keys (source-code
    // payloads, file paths). Transport errors on the auth path are instead
    // logged via `formatTransportError` (network-diagnostics.ts), which emits
    // only known-safe fields as a plain string.
    "syscall",
    "hostname",
    "address",
  ].map((k) => k.toLowerCase()),
)

/** Replacement marker for a redacted string. Keeps the length so size /
 *  truncation bugs stay debuggable without exposing the content. */
function redactString(value: string): string {
  return `[redacted ${value.length} chars]`
}

function isStructuralKey(key: string | undefined): boolean {
  return key !== undefined && STRUCTURAL_STRING_KEYS.has(key.toLowerCase())
}

/**
 * Recursively redact a value for logging. `keyContext` is the object key
 * the value was found under (array elements inherit their parent key),
 * which drives the keep/redact decision for string leaves.
 *
 * Cycles are guarded with a `seen` set so a self-referential payload
 * can't spin the walker.
 */
function redactValue(
  value: unknown,
  keyContext: string | undefined,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    return isStructuralKey(keyContext) ? value : redactString(value)
  }

  // Numbers, booleans, null, undefined, bigint, symbol — structural/config,
  // kept verbatim.
  if (value === null || typeof value !== "object") {
    return value
  }

  if (seen.has(value)) {
    return "[circular]"
  }
  seen.add(value)

  if (Array.isArray(value)) {
    // Array elements inherit the parent key's keep/redact decision.
    return value.map((item) => redactValue(item, keyContext, seen))
  }

  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactValue(inner, key, seen)
  }
  return out
}

/**
 * Public entry point. Returns a redacted deep copy of `value` suitable
 * for serialization into a handler log. The original is never mutated.
 */
export function redactForLog(value: unknown): unknown {
  return redactValue(value, undefined, new WeakSet())
}

/**
 * Mask secret-shaped substrings in a raw STRING before it reaches a file
 * sink. `redactForLog` only redacts string *values under object keys*; a
 * top-level string arg (or a `${secret}` interpolation) bypasses it entirely.
 * This is the fail-closed backstop for direct string logging: even if a call
 * site carelessly passes or interpolates a credential, the token-shaped run is
 * masked on disk. Defense-in-depth — call sites should still avoid logging
 * secrets — but it makes the file sink safe by construction.
 *
 * Patterns masked:
 *   - GitHub tokens: `gho_/ghp_/ghu_/ghr_/ghs_` + ≥20 token chars.
 *   - Copilot bearer tokens: the `tid=…;exp=…;…:sig` shape minted by
 *     `/copilot_internal/v2/token` (keyed off the `tid=` prefix).
 */
export function scrubSecrets(text: string): string {
  return text
    .replaceAll(/\bgh[oprsu]_[A-Za-z0-9]{20,}\b/g, "[redacted github token]")
    .replaceAll(/\btid=[\w;=:./-]{20,}/g, "[redacted copilot token]")
}
