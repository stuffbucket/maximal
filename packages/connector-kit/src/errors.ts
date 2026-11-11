/**
 * Failure classes a connector distinguishes. The setup state machine maps
 * `signed-out` (and a cancelled or timed-out sign-in) to `signin-needed`,
 * the account-level codes to `error` with an admin-facing hint, and treats
 * the rest as transient. `policy-denied` is per tool call: it never changes
 * the connector's state.
 *
 * Account-level codes:
 * - sign-in blocked: `consent-needed` (admin approval required),
 *   `not-assigned` (user not assigned to the app), `conditional-access`,
 *   `app-disabled` (app disabled or missing in the tenant),
 *   `personal-account`;
 * - signed in but not entitled: `not-entitled` (upstream 401 after a
 *   refreshed token, or 403), `license-needed`.
 */
export type ConnectorErrorCode =
  | "signed-out"
  | "sign-in-cancelled"
  | "sign-in-timeout"
  | "port-in-use"
  | "consent-needed"
  | "not-assigned"
  | "conditional-access"
  | "app-disabled"
  | "personal-account"
  | "not-entitled"
  | "license-needed"
  | "policy-denied"
  | "busy"
  | "timeout"
  | "network"
  | "upstream"

const ACCOUNT_LEVEL: ReadonlySet<ConnectorErrorCode> = new Set([
  "signed-out",
  "consent-needed",
  "not-assigned",
  "conditional-access",
  "app-disabled",
  "personal-account",
  "not-entitled",
  "license-needed",
])

/** Codes whose user-facing message a connector may replace with its own wording. */
export type ConnectorMessageCode =
  | "consent-needed"
  | "not-assigned"
  | "conditional-access"
  | "app-disabled"
  | "personal-account"
  | "not-entitled"
  | "license-needed"
  | "policy-denied"

/** Connector-specific wording for account-level and policy failures. */
export interface ConnectorErrorWording {
  messages?: Partial<Record<ConnectorMessageCode, string>>
  /**
   * Admin-facing hint shown with every account-level failure, e.g. which
   * app an administrator must look at.
   */
  adminHint?: string
}

/**
 * Why a call was refused as `busy`:
 * - `throttled` — the service rate-limited it (retries exhausted, or its
 *   `Retry-After` is longer than worth waiting for);
 * - `cooldown` — another call was throttled and the shared cool-down lasts
 *   longer than this call may wait;
 * - `queue-full` / `queue-timeout` — too many calls waiting, or this one
 *   waited too long for a slot;
 * - `outcome-unknown` — a write failed after it was sent (5xx, timeout,
 *   lost connection): it may have been carried out, so it is not retried;
 * - `reset` — the connector reconnected or signed out while the call waited.
 */
export type BusyReason =
  | "throttled"
  | "cooldown"
  | "queue-full"
  | "queue-timeout"
  | "outcome-unknown"
  | "reset"

/** Details of a `busy` failure, for callers and logs. */
export interface BusyDetails {
  reason: BusyReason
  /** When a retry could succeed, if known (ms from now). */
  retryAfterMs?: number
  /** Upstream attempts made. */
  attempts?: number
  /** Time spent queueing and backing off (ms). */
  waitedMs?: number
}

/** A failure with a clear, user-facing English message. */
export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode
  readonly status: number | undefined
  /** Admin-facing hint (shown in the status detail). */
  readonly hint: string | undefined
  /** Set on `busy` failures from the rate limiter. */
  readonly busy: BusyDetails | undefined

  constructor(
    code: ConnectorErrorCode,
    message: string,
    options?: {
      status?: number
      cause?: unknown
      hint?: string
      busy?: BusyDetails
    },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = "ConnectorError"
    this.code = code
    this.status = options?.status
    this.hint = options?.hint
    this.busy = options?.busy
  }

  /** Errors that need the user (or an admin) to act before the connector works. */
  get accountLevel(): boolean {
    return ACCOUNT_LEVEL.has(this.code)
  }
}

/** No usable sign-in: never signed in, signed out, or the refresh token expired. */
export function signedOut(detail?: string, cause?: unknown): ConnectorError {
  return new ConnectorError("signed-out", detail ?? "You are not signed in.", {
    cause,
  })
}

/**
 * An HTTP failure from the upstream endpoint: auth failures, throttling of
 * a `tools/call` (retried above the transport), and exhausted throttling of
 * protocol requests. Carries the body so consent and licence problems can
 * be told apart, and the parsed `Retry-After`.
 */
export class UpstreamHttpError extends Error {
  readonly status: number
  readonly body: string
  readonly wwwAuthenticate: string | undefined
  /** The request was already retried with a freshly refreshed token. */
  readonly refreshed: boolean
  /** The response's `Retry-After`, in ms. */
  readonly retryAfterMs: number | undefined

  constructor(
    status: number,
    body: string,
    options: {
      wwwAuthenticate?: string
      refreshed?: boolean
      retryAfterMs?: number
    } = {},
  ) {
    super(
      `Upstream returned HTTP ${status}${body ? `: ${body.slice(0, 500)}` : ""}`,
    )
    this.name = "UpstreamHttpError"
    this.status = status
    this.body = body
    this.wwwAuthenticate = options.wwwAuthenticate
    this.refreshed = options.refreshed ?? false
    this.retryAfterMs = options.retryAfterMs
  }
}

/** What `toConnectorError` needs to word a failure for one connector. */
export interface ErrorContext {
  /** Connector display name, e.g. "Work IQ". */
  name: string
  /** Configured endpoint (named in network errors). */
  endpoint?: string
  wording?: ConnectorErrorWording
}

// Microsoft Entra (AADSTS) and generic OAuth wording; harmless for other identity providers.
const CONSENT =
  /AADSTS65001|AADSTS90094|AADSTS90008|admin[ _-]?consent|consent[ _-]?required|has not consented|needs? consent|admin approval/i
const NOT_ASSIGNED = /AADSTS50105|not assigned to a role/i
const CONDITIONAL_ACCESS = /AADSTS5300[0-3]|AADSTS53010|conditional access/i
const APP_DISABLED =
  /AADSTS7000112|AADSTS700016|AADSTS7000212|application is disabled|was not found in the directory/i
const LICENSE =
  /licen[cs]e|not entitled|entitlement|copilot (?:seat|subscription)/i
const PERSONAL = /AADSTS50020|AADSTS50177|personal Microsoft account/i
const CANCELLED =
  /access_denied|AADSTS65004|user_cancelled|user canceled|user cancelled/i

const DEFAULT_MESSAGES: Record<ConnectorMessageCode, (name: string) => string> =
  {
    "consent-needed": (name) =>
      `Your organization has not approved ${name}. An administrator must grant consent before you can use it.`,
    "not-assigned": (name) =>
      `Your account is not assigned to ${name} in your organization. Ask your administrator for access.`,
    "conditional-access": (name) =>
      `Your organization's Conditional Access policy blocked sign-in to ${name} (for example a device, location or compliance rule). Contact your administrator.`,
    "app-disabled": (name) =>
      `${name} is disabled or not available in your organization. Ask your administrator to enable it.`,
    "personal-account": (name) =>
      `${name} needs a work or school account; personal Microsoft accounts are not supported.`,
    "not-entitled": (name) =>
      `Your organization hasn't enabled ${name} for this account. You stay signed in; choose Try again once your administrator has enabled it.`,
    "license-needed": (name) =>
      `Your account is not licensed for ${name}. Ask your administrator for a license, then choose Try again.`,
    "policy-denied": (name) =>
      `Your organization's ${name} policy doesn't allow this request.`,
  }

/** Build a connector error in the connector's wording (with its admin hint when account-level). */
export function worded(
  code: ConnectorMessageCode,
  context: ErrorContext,
  options: { status?: number; cause?: unknown } = {},
): ConnectorError {
  const hint = code === "policy-denied" ? undefined : context.wording?.adminHint
  return new ConnectorError(
    code,
    context.wording?.messages?.[code] ?? DEFAULT_MESSAGES[code](context.name),
    { ...options, ...(hint ? { hint } : {}) },
  )
}

/** Identity-provider error codes that block sign-in, most specific first. */
const BLOCKED: ReadonlyArray<[RegExp, ConnectorMessageCode]> = [
  [PERSONAL, "personal-account"],
  [NOT_ASSIGNED, "not-assigned"],
  [CONDITIONAL_ACCESS, "conditional-access"],
  [APP_DISABLED, "app-disabled"],
  [CONSENT, "consent-needed"],
]

/** A failure being classified: the thrown value, all its text, and the wording. */
interface Failure {
  error: unknown
  text: string
  context: ErrorContext
}

/** Sign-in blocked by the identity provider, recognised from its error codes. */
function fromBlockedSignIn(
  failure: Failure,
  status?: number,
): ConnectorError | undefined {
  const code = BLOCKED.find(([pattern]) => pattern.test(failure.text))?.[1]
  if (!code) return undefined
  return worded(code, failure.context, {
    cause: failure.error,
    ...(status === undefined ? {} : { status }),
  })
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ?
      (value as Record<string, unknown>)
    : undefined
}

/** Every piece of text an error carries (message, MSAL fields, HTTP body, causes). */
export function errorText(error: unknown, depth = 0): string {
  if (depth > 4) return ""
  const parts: Array<string> = []
  if (typeof error === "string") return error
  const fields = record(error)
  if (!fields) return String(error)
  for (const key of [
    "message",
    "errorCode",
    "errorMessage",
    "subError",
    "body",
    "wwwAuthenticate",
  ]) {
    if (typeof fields[key] === "string") parts.push(fields[key])
  }
  const data = record(fields.data)
  if (data && typeof data.text === "string") parts.push(data.text)
  if (fields.cause !== undefined) parts.push(errorText(fields.cause, depth + 1))
  return parts.join(" | ")
}

/** The `UpstreamHttpError` in an error's cause chain, if any. */
export function upstreamHttpError(
  error: unknown,
  depth = 0,
): UpstreamHttpError | undefined {
  if (depth > 4) return undefined
  if (error instanceof UpstreamHttpError) return error
  const cause = record(error)?.cause
  return cause === undefined ? undefined : upstreamHttpError(cause, depth + 1)
}

/** HTTP status carried by the error or one of its causes (e.g. an SDK error wrapping our fetch's). */
function httpStatus(error: unknown, depth = 0): number | undefined {
  if (depth > 4) return undefined
  if (error instanceof UpstreamHttpError) return error.status
  const fields = record(error)
  if (!fields) return undefined
  const data = record(fields.data)
  if (data && typeof data.status === "number") return data.status
  if (typeof fields.status === "number") return fields.status
  return fields.cause === undefined ?
      undefined
    : httpStatus(fields.cause, depth + 1)
}

function isNetworkFailure(error: unknown, depth = 0): boolean {
  if (depth > 4) return false
  const fields = record(error)
  if (!fields) return false
  const code = typeof fields.code === "string" ? fields.code : ""
  if (
    /^(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ConnectionRefused|ConnectionClosed|FailedToOpenSocket)$/.test(
      code,
    )
  ) {
    return true
  }
  if (
    error instanceof TypeError
    && /fetch|network|connect|socket/i.test(error.message)
  )
    return true
  if (
    typeof fields.message === "string"
    && /Unable to connect|ConnectionRefused|fetch failed|socket connection was closed/i.test(
      fields.message,
    )
  )
    return true
  return fields.cause !== undefined && isNetworkFailure(fields.cause, depth + 1)
}

/** Whole seconds for messages (at least 1). */
export function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000))
}

function fromStatus(status: number, failure: Failure): ConnectorError {
  const { error, text, context } = failure
  const name = context.name
  const blocked = fromBlockedSignIn(failure, status)
  if (blocked) return blocked
  if (status === 401) {
    // A token the identity provider just refreshed is valid: the service
    // itself refuses this account.
    if (upstreamHttpError(error)?.refreshed)
      return worded("not-entitled", context, { status, cause: error })
    return new ConnectorError(
      "signed-out",
      `${name} did not accept your sign-in (HTTP 401). Sign in again.`,
      { status, cause: error },
    )
  }
  if (status === 403) {
    return worded(
      LICENSE.test(text) ? "license-needed" : "not-entitled",
      context,
      { status, cause: error },
    )
  }
  if (status === 429 || status === 503 || status === 504) {
    const retryAfterMs = upstreamHttpError(error)?.retryAfterMs
    return new ConnectorError(
      "busy",
      `${name} is busy (HTTP ${status}). Try again ${retryAfterMs === undefined ? "in a moment" : `in about ${seconds(retryAfterMs)} s`}.`,
      {
        status,
        cause: error,
        busy: {
          reason: "throttled",
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        },
      },
    )
  }
  return new ConnectorError(
    "upstream",
    `${name} request failed (HTTP ${status}).`,
    { status, cause: error },
  )
}

/** MSAL's "the user must sign in again" family. */
function fromInteractionRequired(failure: Failure): ConnectorError | undefined {
  const fields = record(failure.error)
  const name = typeof fields?.name === "string" ? fields.name : ""
  const msalCode = typeof fields?.errorCode === "string" ? fields.errorCode : ""
  if (
    name !== "InteractionRequiredAuthError"
    && !/interaction_required|login_required|invalid_grant|no_tokens_found|no_account/i.test(
      msalCode,
    )
  )
    return undefined
  return (
    fromBlockedSignIn(failure)
    ?? signedOut(
      `Your ${failure.context.name} sign-in has expired. Sign in again.`,
      failure.error,
    )
  )
}

/** Sign-in failures recognised from the error text alone. */
function fromSignInText(failure: Failure): ConnectorError | undefined {
  const blocked = fromBlockedSignIn(failure)
  if (blocked) return blocked
  if (CANCELLED.test(failure.text))
    return new ConnectorError("sign-in-cancelled", "Sign-in was cancelled.", {
      cause: failure.error,
    })
  return undefined
}

function fromTransport(failure: Failure): ConnectorError | undefined {
  const { error, context } = failure
  if (record(error)?.code === "REQUEST_TIMEOUT") {
    return new ConnectorError(
      "timeout",
      `${context.name} did not respond in time. Try again.`,
      { cause: error },
    )
  }
  if (!isNetworkFailure(error)) return undefined
  const where = context.endpoint ? ` at ${new URL(context.endpoint).host}` : ""
  return new ConnectorError(
    "network",
    `Could not reach ${context.name}${where}. Check your network connection.`,
    { cause: error },
  )
}

/**
 * Normalise anything thrown by a sign-in strategy, the MCP client or the
 * retrying fetch into a `ConnectorError` with a clear English message.
 */
export function toConnectorError(
  error: unknown,
  context: ErrorContext,
): ConnectorError {
  if (error instanceof ConnectorError) return error
  const failure: Failure = { error, text: errorText(error), context }
  const status = httpStatus(error)
  if (status !== undefined && status >= 400) return fromStatus(status, failure)

  const known =
    fromInteractionRequired(failure)
    ?? fromSignInText(failure)
    ?? fromTransport(failure)
  if (known) return known
  const detail =
    error instanceof Error && error.message ? error.message : String(error)
  return new ConnectorError(
    "upstream",
    `${context.name} request failed: ${detail}`,
    { cause: error },
  )
}

/** True when `error` is (or wraps) an abort. */
export function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  const fields = record(error)
  return fields?.name === "AbortError"
}
