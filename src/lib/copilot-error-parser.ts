/**
 * Shared parser for non-OK upstream responses from any Copilot endpoint
 * (token mint at /copilot_internal/v2/token, completions at /v1/messages,
 * /v1/chat/completions, /responses). Two responsibilities:
 *
 *   1. Pull a human message + remediation URL out of an opaque response
 *      body (JSON or plain text). The shape isn't a documented contract;
 *      observed forms include {message, documentation_url},
 *      {notification: {message, url}}, plain text with an embedded
 *      github.com URL, and {error, error_description}.
 *
 *   2. Discriminate auth-fatal rejections (license revoked, TOS not
 *      accepted, org policy block — re-auth is the only resolution)
 *      from non-fatal rejections (quota exhausted, model not on plan,
 *      transient upstream error — DO NOT sign out; surface a banner
 *      and let the next successful request clear it).
 *
 * Conservative discrimination policy:
 *   - 401 → always auth-fatal. The credentials didn't authenticate.
 *   - 403 → auth-fatal ONLY if the body contains license/TOS/subscription
 *     markers OR points at a GitHub remediation URL associated with
 *     account entitlement. Otherwise non-fatal (model denial, etc.).
 *   - 402, 429, other 4xx, 5xx → never auth-fatal.
 *
 * Mis-classifying a model-denial 403 as auth-fatal would silently sign
 * the user out and force a pointless re-auth into the same state. False
 * negatives are cheap (sidecar banner shows the upstream message + URL;
 * user reads it). So we lean conservative on the auth-fatal verdict.
 */

export interface ParsedCopilotError {
  message: string
  remediationUrl: string | null
}

export function parseCopilotErrorBody(body: string): ParsedCopilotError {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return {
      message: body.trim() || "Copilot returned an error.",
      remediationUrl: findGithubUrl(body),
    }
  }

  const message = extractMessage(parsed) ?? "Copilot returned an error."
  const remediationUrl = extractRemediationUrl(parsed) ?? findGithubUrl(body)
  return { message, remediationUrl }
}

/**
 * True if the upstream response should collapse the GitHub token to a
 * signed-out state (license revoked, TOS not accepted, org policy
 * block). Conservative — 403s without explicit account-entitlement
 * markers stay non-fatal so the user keeps their session.
 */
export function isAuthFatal(
  status: number,
  parsed: ParsedCopilotError,
): boolean {
  if (status === 401) return true
  if (status !== 403) return false

  const text = `${parsed.message} ${parsed.remediationUrl ?? ""}`.toLowerCase()
  // Specific markers GHCP has been observed to use for account-level
  // rejections. Adding to this list is forward-compatible — a missed
  // marker degrades to "show banner" rather than "force sign-out."
  const markers = [
    "terms of service",
    "terms-of-service",
    "site/terms",
    "settings/copilot",
    "copilot/signup",
    "not entitled",
    "license revoked",
    "license has been",
    "subscription has been",
    "subscription required",
    "no copilot license",
    "accept the terms",
  ]
  return markers.some((m) => text.includes(m))
}

function extractMessage(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.message === "string") return obj.message
  const notif = obj.notification
  if (typeof notif === "object" && notif !== null) {
    const m = (notif as Record<string, unknown>).message
    if (typeof m === "string") return m
  }
  if (typeof obj.error === "string") return obj.error
  if (typeof obj.error_description === "string") return obj.error_description
  return null
}

function extractRemediationUrl(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  const candidates = [
    obj.documentation_url,
    obj.message_url,
    obj.url,
    (obj.notification as Record<string, unknown> | undefined)?.url,
  ]
  for (const c of candidates) {
    if (typeof c === "string" && /^https?:\/\//.test(c)) return c
  }
  return null
}

function findGithubUrl(text: string): string | null {
  const match = /https:\/\/github\.com\/[^\s"<>)]+/.exec(text)
  return match ? match[0] : null
}
