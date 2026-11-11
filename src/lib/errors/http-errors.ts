/**
 * The errors the proxy raises and the inference routes' error handler
 * (`proxy-errors.ts`) turns into client replies. Kept apart from
 * `error.ts` so that handler can use them without an import cycle.
 */

import { HTTPException } from "hono/http-exception"

/** The Copilot call an upstream error answered: the endpoint path as the
 *  model catalog's `supported_endpoints` spells it (`/chat/completions`,
 *  `/v1/images/generations`, ...) and the model the request named. */
export interface UpstreamCall {
  endpoint: string
  model?: string
}

/** The upstream answered with an error; `response` is its response and
 *  `call`, when known, the request it refused. */
export class HTTPError extends Error {
  response: Response
  call?: UpstreamCall

  constructor(message: string, response: Response, call?: UpstreamCall) {
    super(message)
    this.response = response
    this.call = call
  }
}

/**
 * Thrown when GHCP rejects our GitHub token at the Copilot exchange
 * (401/403). Carries the upstream message and any remediation URL
 * (e.g. updated Copilot TOS, license-management page) so the auth
 * controller can stash both for the Settings UI to render.
 *
 * Distinct from HTTPError because the action is fixed: clear the
 * token, stop the refresh loop, show the user how to recover. The
 * refresh loop and setup path discriminate on this type.
 */
export class CopilotAuthFatalError extends Error {
  status: number
  remediationUrl: string | null

  constructor(message: string, status: number, remediationUrl: string | null) {
    super(message)
    this.status = status
    this.remediationUrl = remediationUrl
  }
}

export const NOT_SIGNED_IN_HINT =
  "Open Settings → Account to sign in, or run `maximal auth`."

/**
 * There is no upstream to forward to: Maximal has no GitHub sign-in.
 * Thrown by `requireGithubAuth`. Its own response is the
 * `401 { error: "not_authenticated", hint }` contract the Dashboard reads
 * (`/usage`); the inference routes' error handler answers in the client's
 * format instead.
 */
export class NoUpstreamError extends HTTPException {
  readonly reason = "not-signed-in" as const

  constructor() {
    super(401, {
      message: "Maximal isn't signed in to GitHub.",
      res: Response.json(
        { error: "not_authenticated", hint: NOT_SIGNED_IN_HINT },
        { status: 401 },
      ),
    })
  }
}
