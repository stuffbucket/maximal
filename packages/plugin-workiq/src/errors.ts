import { WORKIQ_CLIENT_ID } from "./config"

/**
 * Failure classes the plugin distinguishes. The setup state machine maps
 * `signed-out` to `signin-needed`, the account-level codes (`consent-needed`,
 * `license-needed`, `access-denied`) to `error`, and treats the rest as
 * transient.
 */
export type WorkIqErrorCode =
  | "signed-out"
  | "sign-in-cancelled"
  | "sign-in-timeout"
  | "consent-needed"
  | "license-needed"
  | "access-denied"
  | "personal-account"
  | "busy"
  | "timeout"
  | "network"
  | "upstream"

/** A failure with a clear, user-facing English message. */
export class WorkIqError extends Error {
  readonly code: WorkIqErrorCode
  readonly status: number | undefined

  constructor(
    code: WorkIqErrorCode,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = "WorkIqError"
    this.code = code
    this.status = options?.status
  }

  /** Errors that need the user (or an admin) to act before Work IQ works. */
  get accountLevel(): boolean {
    return (
      this.code === "signed-out"
      || this.code === "consent-needed"
      || this.code === "license-needed"
      || this.code === "access-denied"
      || this.code === "personal-account"
    )
  }
}

/** No usable sign-in: never signed in, signed out, or the refresh token expired. */
export function signedOut(detail?: string, cause?: unknown): WorkIqError {
  return new WorkIqError(
    "signed-out",
    detail ?? "Sign in to Work IQ with your work or school account.",
    { cause },
  )
}

/**
 * An HTTP failure from the Work IQ endpoint that the retrying fetch gave up
 * on (auth failures and exhausted throttling). Carries the body so consent
 * and licence problems can be told apart.
 */
export class UpstreamHttpError extends Error {
  readonly status: number
  readonly body: string
  readonly wwwAuthenticate: string | undefined

  constructor(status: number, body: string, wwwAuthenticate?: string) {
    super(
      `Work IQ returned HTTP ${status}${body ? `: ${body.slice(0, 500)}` : ""}`,
    )
    this.name = "UpstreamHttpError"
    this.status = status
    this.body = body
    this.wwwAuthenticate = wwwAuthenticate
  }
}

const CONSENT =
  /AADSTS65001|AADSTS90094|AADSTS90008|AADSTS700016|admin[ _-]?consent|consent[ _-]?required|has not consented|needs? consent/i
const LICENSE =
  /licen[cs]e|not entitled|entitlement|copilot (?:seat|subscription)/i
const PERSONAL = /AADSTS50020|AADSTS50177|personal Microsoft account/i
const CANCELLED =
  /access_denied|AADSTS65004|user_cancelled|user canceled|user cancelled/i

export const CONSENT_MESSAGE = `Your organization has not approved Work IQ. A Microsoft Entra admin must grant tenant-wide admin consent to the Work IQ app (${WORKIQ_CLIENT_ID}).`
export const LICENSE_MESSAGE =
  "Your account is not licensed for Work IQ. Ask your Microsoft 365 admin for a license that includes Work IQ (Microsoft 365 Copilot)."

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ?
      (value as Record<string, unknown>)
    : undefined
}

/** Every piece of text an error carries (message, MSAL fields, HTTP body, causes). */
function errorText(error: unknown, depth = 0): string {
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

function httpStatus(error: unknown): number | undefined {
  if (error instanceof UpstreamHttpError) return error.status
  const fields = record(error)
  const data = record(fields?.data)
  if (data && typeof data.status === "number") return data.status
  if (fields && typeof fields.status === "number") return fields.status
  return undefined
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

function fromStatus(status: number, text: string, error: unknown): WorkIqError {
  if (CONSENT.test(text))
    return new WorkIqError("consent-needed", CONSENT_MESSAGE, {
      status,
      cause: error,
    })
  if (status === 401) {
    return new WorkIqError(
      "signed-out",
      "Work IQ did not accept your sign-in (HTTP 401). Sign in again.",
      { status, cause: error },
    )
  }
  if (status === 403) {
    if (LICENSE.test(text))
      return new WorkIqError("license-needed", LICENSE_MESSAGE, {
        status,
        cause: error,
      })
    return new WorkIqError(
      "access-denied",
      `Work IQ denied access (HTTP 403). Your tenant must grant admin consent to the Work IQ app (${WORKIQ_CLIENT_ID}) and your account needs a Work IQ license.`,
      { status, cause: error },
    )
  }
  if (status === 429 || status === 503 || status === 504) {
    return new WorkIqError(
      "busy",
      `Work IQ is busy (HTTP ${status}). Try again in a moment.`,
      { status, cause: error },
    )
  }
  return new WorkIqError(
    "upstream",
    `Work IQ request failed (HTTP ${status}).`,
    { status, cause: error },
  )
}

/** MSAL's "the user must sign in again" family. */
function fromInteractionRequired(
  fields: Record<string, unknown> | undefined,
  text: string,
  error: unknown,
): WorkIqError | undefined {
  const name = typeof fields?.name === "string" ? fields.name : ""
  const msalCode = typeof fields?.errorCode === "string" ? fields.errorCode : ""
  if (
    name !== "InteractionRequiredAuthError"
    && !/interaction_required|login_required|invalid_grant|no_tokens_found|no_account/i.test(
      msalCode,
    )
  )
    return undefined
  if (CONSENT.test(text))
    return new WorkIqError("consent-needed", CONSENT_MESSAGE, { cause: error })
  return signedOut("Your Work IQ sign-in has expired. Sign in again.", error)
}

/** Sign-in failures recognised from the error text alone. */
function fromSignInText(text: string, error: unknown): WorkIqError | undefined {
  if (PERSONAL.test(text)) {
    return new WorkIqError(
      "personal-account",
      "Work IQ needs a work or school account; personal Microsoft accounts are not supported.",
      { cause: error },
    )
  }
  if (CONSENT.test(text))
    return new WorkIqError("consent-needed", CONSENT_MESSAGE, { cause: error })
  if (CANCELLED.test(text))
    return new WorkIqError("sign-in-cancelled", "Sign-in was cancelled.", {
      cause: error,
    })
  return undefined
}

function fromTransport(
  fields: Record<string, unknown> | undefined,
  error: unknown,
  endpoint: string | undefined,
): WorkIqError | undefined {
  if (fields?.code === "REQUEST_TIMEOUT") {
    return new WorkIqError(
      "timeout",
      "Work IQ did not respond in time. Try again.",
      { cause: error },
    )
  }
  if (!isNetworkFailure(error)) return undefined
  const where = endpoint ? ` at ${new URL(endpoint).host}` : ""
  return new WorkIqError(
    "network",
    `Could not reach Work IQ${where}. Check your network connection.`,
    { cause: error },
  )
}

/**
 * Normalise anything thrown by MSAL, the MCP client or the retrying fetch
 * into a `WorkIqError` with a clear English message.
 */
export function toWorkIqError(error: unknown, endpoint?: string): WorkIqError {
  if (error instanceof WorkIqError) return error
  const text = errorText(error)
  const status = httpStatus(error)
  if (status !== undefined && status >= 400)
    return fromStatus(status, text, error)

  const fields = record(error)
  const known =
    fromInteractionRequired(fields, text, error)
    ?? fromSignInText(text, error)
    ?? fromTransport(fields, error, endpoint)
  if (known) return known
  const message =
    error instanceof Error && error.message ? error.message : String(error)
  return new WorkIqError("upstream", `Work IQ request failed: ${message}`, {
    cause: error,
  })
}

/** True when `error` is (or wraps) an abort. */
export function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  const fields = record(error)
  return fields?.name === "AbortError"
}
