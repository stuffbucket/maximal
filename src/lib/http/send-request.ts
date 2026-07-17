/**
 * The single authenticated-HTTP mechanism.
 *
 * Every outbound request that carries a credential funnels through one `fetch`
 * sink here, and the mechanism — not the caller — decides which credential to
 * attach. The rule is: **the destination host determines the credential.** For
 * the four fixed first-party hosts (Copilot, GitHub API, direct Anthropic, and
 * the unauthenticated GitHub OAuth endpoints) the caller passes only a URL, and
 * `attachHostAuth` maps host → token + scheme. A caller therefore cannot select
 * the wrong credential — there is no credential argument to get wrong.
 *
 * The one case the host cannot resolve is the config-selected passthrough
 * provider (`/:provider/*`): its base URL is arbitrary user config, so the
 * resolved `ResolvedProviderConfig` (host + key + scheme, bundled) is passed to
 * `sendProviderRequest`. That is supplying the credential *object*, not choosing
 * among ambiguous labels.
 *
 * Either way, the token is read and turned into an `Authorization` / `x-api-key`
 * header on a function-local `Headers` that is never returned; callers get a
 * `Response` out. This is also the single CodeQL `js/file-access-to-http` sink.
 * The invariant "tokens are attached only here" is enforced by an ESLint
 * `no-restricted-syntax` rule (see `eslint.config.js`). See ADR-0001.
 */

import type { ResolvedProviderConfig } from "~/lib/config/config"

import {
  copilotBaseUrl,
  getGitHubApiBaseUrl,
  isOpencodeOauthApp,
} from "~/lib/config/api-config"
import { getAnthropicApiKey } from "~/lib/config/config"
import { HTTPError } from "~/lib/errors/error"
import { state } from "~/lib/runtime-state/state"

const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com"

export interface SendRequestInit extends Omit<RequestInit, "headers"> {
  /** Request-specific NON-secret headers only. The mechanism attaches auth. */
  headers?: Record<string, string>
  /** Abort after this many ms via `AbortSignal.timeout`. Explicit `signal` wins. */
  timeoutMs?: number
  /**
   * Override the GitHub token for a GitHub-API request. Used only during
   * sign-in, to validate a candidate token before it is committed to `state`.
   * Supplies a *value* the mechanism can't yet read from state — it does not
   * change which credential the host selects.
   */
  githubToken?: string
}

/**
 * Map the destination host to its credential and attach it. The ONLY reader of
 * a token for the wire. Not exported: nothing outside this module can obtain
 * the token or reproduce the auth string. `Headers.set` is case-normalized, so
 * it reliably overwrites any stray auth value a caller may have passed.
 *
 * An unrecognized host (e.g. the GitHub OAuth device/access-token endpoints on
 * `github.com/login/*`, which authenticate via a public client_id in the body)
 * gets no credential — a safe default: a typo'd host fails unauthenticated
 * rather than leaking a token to the wrong place.
 */
/**
 * True iff `url`'s origin (scheme + host + port) exactly equals `baseUrl`'s.
 *
 * Host matching MUST parse the URL and compare origins — never a string
 * prefix. `"https://api.anthropic.com".startsWith`-style checks match hostile
 * lookalikes such as `https://api.anthropic.com.evil.com/…`, which would
 * attach our credential and send it to the attacker's domain
 * (CodeQL js/incomplete-url-substring-sanitization). A URL that fails to parse
 * matches nothing → no credential attached (safe default).
 */
function isSameOrigin(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(baseUrl).origin
  } catch {
    return false
  }
}

function attachHostAuth(
  url: string,
  headers: Headers,
  githubTokenOverride?: string,
): void {
  if (isSameOrigin(url, copilotBaseUrl(state))) {
    headers.set("authorization", `Bearer ${state.copilotToken}`)
    return
  }
  if (isSameOrigin(url, getGitHubApiBaseUrl())) {
    const token = githubTokenOverride ?? state.githubToken
    // opencode's GitHub OAuth app expects a Bearer token; the standard
    // (VS Code) identity expects the legacy `token <x>` scheme.
    headers.set(
      "authorization",
      isOpencodeOauthApp() ? `Bearer ${token}` : `token ${token}`,
    )
    return
  }
  if (isSameOrigin(url, ANTHROPIC_API_BASE_URL)) {
    // Direct Anthropic API (count_tokens). Key from config/env/file; callers
    // gate on its presence but never read it.
    const key = getAnthropicApiKey()
    if (key) headers.set("x-api-key", key)
    return
  }
  // Any other host carries no credential.
}

/** Attach a config-selected passthrough provider's credential (see module doc). */
function attachProviderAuth(
  providerConfig: ResolvedProviderConfig,
  headers: Headers,
): void {
  if (providerConfig.authType === "authorization") {
    headers.set("authorization", `Bearer ${providerConfig.apiKey}`)
  } else {
    headers.set("x-api-key", providerConfig.apiKey)
  }
}

/**
 * The ONE fetch sink. Given a URL and an already-authorized `Headers`, send it.
 * The single CodeQL `js/file-access-to-http` suppression lives here.
 */
function dispatch(
  url: string,
  authorized: Headers,
  init: SendRequestInit,
): Promise<Response> {
  const {
    timeoutMs,
    signal,
    headers: _headers,
    githubToken: _token,
    ...rest
  } = init
  return fetch(url, {
    // codeql[js/file-access-to-http] -- by design, the SINGLE chokepoint: the
    // proxy reads its own 0o600 GitHub/Copilot token (or a configured provider
    // key) and forwards it upstream as Authorization. Same posture as
    // gh/aws/kubectl. Every authenticated fetch funnels here, so this is the
    // only suppression. See ADR-0001.
    ...rest,
    headers: authorized,
    signal:
      signal
      ?? (timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)),
  })
}

/**
 * Send a request to a first-party host. The credential is selected from the
 * destination host — the caller passes only a URL (plus, for the sign-in flow,
 * an optional `githubToken` value). Returns the raw `Response` so callers keep
 * full control of streaming, status handling, and error mapping.
 */
export async function sendRequest(
  url: string,
  init: SendRequestInit = {},
): Promise<Response> {
  const merged = new Headers(init.headers)
  attachHostAuth(url, merged, init.githubToken)
  return dispatch(url, merged, init)
}

/**
 * Send a request to a config-selected passthrough provider. The credential is
 * the provider's own (host + key + scheme travel together in `providerConfig`),
 * so there is no host-inference here — the `/:provider/*` route already resolved
 * which provider this is.
 */
export async function sendProviderRequest(
  providerConfig: ResolvedProviderConfig,
  url: string,
  init: SendRequestInit = {},
): Promise<Response> {
  const merged = new Headers(init.headers)
  attachProviderAuth(providerConfig, merged)
  return dispatch(url, merged, init)
}

/**
 * A minimal structural validator — satisfied by any Zod schema (`.parse`). Keeps
 * this auth sink decoupled from the validation library while still forcing every
 * JSON boundary through a runtime check instead of an unsound `as T` cast.
 */
export interface JsonValidator<T> {
  parse(input: unknown): T
}

/**
 * Convenience for the auth/discovery shape: a bounded (or unbounded) read, an
 * `ok` check that throws `HTTPError`, and a **validated** JSON parse. The schema
 * turns the untrusted response body into `T` at runtime, so a missing or
 * mistyped field fails loudly here instead of silently becoming
 * `undefined`/`NaN` downstream (the class of bug behind the device-code
 * `interval`/`expires_in` poll spin). Callers with bespoke non-OK handling
 * (strict auth-fatal, 200-with-error bodies) use `sendRequest` + their own parse.
 */
export async function sendRequestJson<T>(
  url: string,
  init: SendRequestInit & { errorMessage: string },
  schema: JsonValidator<T>,
): Promise<T> {
  const { errorMessage, ...rest } = init
  const response = await sendRequest(url, rest)
  if (!response.ok) throw new HTTPError(errorMessage, response)
  return schema.parse(await response.json())
}
