/**
 * The single authenticated-HTTP mechanism.
 *
 * Every outbound request that carries a credential funnels through
 * `sendRequest` / `sendRequestJson`. Callers name WHICH credential domain they
 * need (or `none`) but never read, construct, or see the token: `authHeadersFor`
 * — the only place in the codebase that reads `state.copilotToken`,
 * `state.githubToken`, or a provider API key for the wire — is module-private,
 * and the finalized (tokened) `Headers` is a function-local that is never
 * returned. Callers pass non-secret request headers IN and get a `Response` /
 * parsed JSON OUT; the tokened request is sent to the network from in here and
 * is not observable outside this module.
 *
 * This is also the single CodeQL `js/file-access-to-http` sink: the disk-read
 * token reaches an HTTP request in exactly one annotated line below.
 *
 * The invariant "tokens are attached only here" is enforced by an ESLint
 * `no-restricted-syntax` rule (see `eslint.config.js`) that forbids reading the
 * token fields or building `Bearer `/`token `/`x-api-key` auth strings anywhere
 * except this file, plus a grep arch-test in the suite. See ADR-0001.
 */

import type { ResolvedProviderConfig } from "~/lib/config"

import { isOpencodeOauthApp } from "~/lib/api-config"
import { getAnthropicApiKey } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

/**
 * Which credential the mechanism should attach — by token SOURCE + scheme, not
 * by endpoint. `copilot` vs "copilot models" and `github` vs "github user"
 * differ only in NON-secret headers (which callers own), so they collapse here.
 */
export type Credential =
  | { domain: "copilot" }
  | { domain: "github"; token?: string }
  | { domain: "provider"; config: ResolvedProviderConfig }
  | { domain: "anthropic" }
  | { domain: "none" }

export interface SendRequestInit extends Omit<RequestInit, "headers"> {
  credential: Credential
  /** Request-specific NON-secret headers only. The mechanism attaches auth. */
  headers?: Record<string, string>
  /** Abort after this many ms via `AbortSignal.timeout`. Explicit `signal` wins. */
  timeoutMs?: number
}

/**
 * Attach the credential's auth header. The ONLY reader of a token for the wire.
 * Not exported: nothing outside this module can obtain the token or reproduce
 * the auth string. Mutates `headers` in place; `Headers.set` is case-normalized
 * so it reliably overwrites any stray auth value a caller may have passed.
 */
function attachAuth(credential: Credential, headers: Headers): void {
  switch (credential.domain) {
    case "copilot": {
      headers.set("authorization", `Bearer ${state.copilotToken}`)
      return
    }
    case "github": {
      const token = credential.token ?? state.githubToken
      // opencode's GitHub OAuth app expects a Bearer token; the standard
      // (VS Code) identity expects the legacy `token <x>` scheme.
      headers.set(
        "authorization",
        isOpencodeOauthApp() ? `Bearer ${token}` : `token ${token}`,
      )
      return
    }
    case "provider": {
      if (credential.config.authType === "authorization") {
        headers.set("authorization", `Bearer ${credential.config.apiKey}`)
      } else {
        headers.set("x-api-key", credential.config.apiKey)
      }
      return
    }
    case "anthropic": {
      // Direct Anthropic API (count_tokens). The key comes from config/env/file
      // via getAnthropicApiKey(); callers gate on its presence but never read it.
      const key = getAnthropicApiKey()
      if (key) headers.set("x-api-key", key)
      return
    }
    // Unauthenticated flows ("none") — OAuth device-code / access-token polling
    // carry a public client_id in the body, no bearer. Also the safe default.
    default: {
      return
    }
  }
}

/**
 * Send an authenticated request. Returns the raw `Response` so callers keep
 * full control of streaming, status handling, and error mapping.
 */
export async function sendRequest(
  url: string,
  init: SendRequestInit,
): Promise<Response> {
  const { credential, timeoutMs, signal, headers, ...rest } = init
  const merged = new Headers(headers)
  attachAuth(credential, merged)
  return fetch(url, {
    // codeql[js/file-access-to-http] -- by design, the SINGLE chokepoint: the
    // proxy reads its own 0o600 GitHub/Copilot token (or a configured provider
    // key) and forwards it upstream as Authorization. Same posture as
    // gh/aws/kubectl. Every authenticated fetch funnels here, so this is the
    // only suppression. See ADR-0001.
    ...rest,
    headers: merged,
    signal:
      signal
      ?? (timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)),
  })
}

/**
 * Convenience for the auth/discovery shape: a bounded (or unbounded) read, an
 * `ok` check that throws `HTTPError`, and a JSON parse. Callers with bespoke
 * non-OK handling (strict auth-fatal, 200-with-error bodies) use `sendRequest`.
 */
export async function sendRequestJson<T>(
  url: string,
  init: SendRequestInit & { errorMessage: string },
): Promise<T> {
  const { errorMessage, ...rest } = init
  const response = await sendRequest(url, rest)
  if (!response.ok) throw new HTTPError(errorMessage, response)
  return (await response.json()) as T
}
