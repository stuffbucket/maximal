import clipboard from "clipboardy"
import consola from "consola"
import { setTimeout as delay } from "node:timers/promises"

import { PATHS } from "~/lib/paths"
import { getCopilotToken as defaultGetCopilotToken } from "~/services/github/get-copilot-token"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { markAuthFatalAndSignOut as defaultMarkAuthFatalAndSignOut } from "./auth-controller"
import { toCopilotHost } from "./auth-types"
import { CopilotAuthFatalError, HTTPError } from "./error"
import {
  inferTokenType,
  makeRecord,
  readDefaultRecord,
  writeDefaultRecord,
} from "./github-token-store"
import { isHeadless, openUrl } from "./open-url"
import { setCopilotToken, state } from "./state"

// Dependency-injection shim for tests, mirroring the pattern in
// `auth-controller.ts`. Process-wide `mock.module` for these symbols
// leaks across test files (Bun's module registry persists for the
// duration of `bun test`); the DI shim keeps the registry untouched
// while still letting `tests/token-auth-fatal.test.ts` observe how
// the refresh loop reacts to CopilotAuthFatalError. Production
// callers see the real implementations.
let getCopilotToken: typeof defaultGetCopilotToken = defaultGetCopilotToken
let markAuthFatalAndSignOut: typeof defaultMarkAuthFatalAndSignOut =
  defaultMarkAuthFatalAndSignOut

export interface TokenDepsTestOverrides {
  getCopilotToken?: typeof defaultGetCopilotToken
  markAuthFatalAndSignOut?: typeof defaultMarkAuthFatalAndSignOut
}

export function __setTokenDepsForTests(
  overrides: TokenDepsTestOverrides,
): void {
  if (overrides.getCopilotToken !== undefined) {
    getCopilotToken = overrides.getCopilotToken
  }
  if (overrides.markAuthFatalAndSignOut !== undefined) {
    markAuthFatalAndSignOut = overrides.markAuthFatalAndSignOut
  }
}

export function __resetTokenDepsForTests(): void {
  getCopilotToken = defaultGetCopilotToken
  markAuthFatalAndSignOut = defaultMarkAuthFatalAndSignOut
}

let copilotRefreshLoopController: AbortController | null = null

// The /copilot_internal/v2/token response carries the authoritative completion
// host for the bearer it mints (`endpoints.api`). GitHub can migrate an account
// between hosts (individual → enterprise on a plan/billing change); the token is
// only valid against its own host, and POSTing it elsewhere is rejected with 421
// Misdirected Request. Re-applying this on every mint AND refresh lets a
// long-running session self-heal across a migration without a restart.
const applyCopilotApiUrl = (api: string | undefined) => {
  if (!api) return
  // Validate + brand at the boundary: only a well-formed https origin reaches
  // the completion-host slot (boundary D1 — see auth-types.ts).
  const host = toCopilotHost(api)
  if (!host) {
    consola.warn(`Ignoring malformed Copilot API host from discovery: ${api}`)
    return
  }
  if (host === state.copilotApiUrl) return
  consola.debug(`Copilot API host -> ${host}`)
  state.copilotApiUrl = host
}

export const stopCopilotRefreshLoop = () => {
  if (!copilotRefreshLoopController) {
    return
  }

  copilotRefreshLoopController.abort()
  copilotRefreshLoopController = null
}

export const setupCopilotToken = async () => {
  // Runtime token-type detection: `gho_` tokens (OAuth-App user tokens, e.g.
  // opencode-style or any Ov23li…-prefixed app) are accepted directly by the
  // Copilot edge, don't expire, and need no refresh loop. `ghu_` tokens
  // (GitHub-App user-to-server tokens, our default from Iv1.b507a08c87ecfe98)
  // require the existing /copilot_internal/v2/token exchange + refresh.
  const githubToken = state.githubToken
  if (githubToken && inferTokenType(githubToken) === "gho_") {
    setCopilotToken(githubToken)

    consola.debug("Using gho_ token directly as Copilot bearer; no refresh")
    if (state.showToken) {
      consola.info("Copilot token:", state.copilotToken)
    }

    stopCopilotRefreshLoop()
    return
  }

  let token: string
  let refresh_in: number
  try {
    const result = await getCopilotToken()
    token = result.token
    refresh_in = result.refresh_in
    applyCopilotApiUrl(result.endpoints?.api)
  } catch (error) {
    if (error instanceof CopilotAuthFatalError) {
      // First-mint failure (e.g. user lacks Copilot entitlement, must
      // accept new TOS). Treat the GitHub token as gone — same
      // collapse rule as the refresh loop — and surface the reason.
      consola.warn(
        "Copilot rejected the GitHub token at first mint:",
        error.message,
      )
      await markAuthFatalAndSignOut(error)
      throw error
    }
    throw error
  }
  setCopilotToken(token)

  consola.debug("GitHub Copilot Token fetched successfully!")
  if (state.showToken) {
    consola.info("Copilot token:", token)
  }

  stopCopilotRefreshLoop()

  const controller = new AbortController()
  copilotRefreshLoopController = controller

  runCopilotRefreshLoop(refresh_in, controller.signal)
    .catch(() => {
      consola.warn("Copilot token refresh loop stopped")
    })
    .finally(() => {
      if (copilotRefreshLoopController === controller) {
        copilotRefreshLoopController = null
      }
    })
}

const REFRESH_POLL_INTERVAL_MS = 15_000
const EARLY_REFRESH_BUFFER_MS = 60_000
const RETRY_REFRESH_DELAY_MS = 15_000
const MIN_REFRESH_DELAY_MS = 1_000

export const getRefreshDeadlineMs = (
  refreshIn: number,
  nowMs: number = Date.now(),
) =>
  nowMs
  + Math.max(refreshIn * 1000 - EARLY_REFRESH_BUFFER_MS, MIN_REFRESH_DELAY_MS)

// Use short wall-clock chunks so the next wake after sleep notices elapsed time
// quickly, without relying on the server's absolute expires_at matching local time.
export const getRefreshPollDelayMs = (
  refreshAtMs: number,
  nowMs: number = Date.now(),
) => Math.min(Math.max(refreshAtMs - nowMs, 0), REFRESH_POLL_INTERVAL_MS)

const runCopilotRefreshLoop = async (
  refreshIn: number,
  signal: AbortSignal,
) => {
  let refreshAtMs = getRefreshDeadlineMs(refreshIn)

  while (!signal.aborted) {
    const nextDelayMs = getRefreshPollDelayMs(refreshAtMs)
    if (nextDelayMs > 0) {
      await delay(nextDelayMs, undefined, { signal })
      continue
    }

    consola.debug("Refreshing Copilot token")

    try {
      const { token, refresh_in, endpoints } = await getCopilotToken()
      setCopilotToken(token)
      applyCopilotApiUrl(endpoints?.api)
      refreshAtMs = getRefreshDeadlineMs(refresh_in)
      consola.debug("Copilot token refreshed")
      if (state.showToken) {
        consola.info("Refreshed Copilot token:", token)
      }
    } catch (error) {
      if (error instanceof CopilotAuthFatalError) {
        // GHCP rejected the GitHub token (401/403). No amount of
        // retrying will fix this; the user has to re-authenticate
        // (and possibly accept new TOS / re-enable Copilot upstream).
        // Wipe local auth state, stash the rejection reason for the
        // Settings UI, and exit the loop. A successful sign-in will
        // spin up a fresh loop via setupCopilotToken.
        consola.warn(
          "Copilot rejected the GitHub token; stopping refresh loop:",
          error.message,
        )
        await markAuthFatalAndSignOut(error)
        return
      }
      consola.error("Failed to refresh Copilot token:", error)
      refreshAtMs = Date.now() + RETRY_REFRESH_DELAY_MS
      consola.warn(
        `Retrying Copilot token refresh in ${RETRY_REFRESH_DELAY_MS / 1000}s`,
      )
    }
  }
}

interface SetupGitHubTokenOptions {
  force?: boolean
  /** Skip the auto-browser-open step; print the URL/code only. */
  noBrowser?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const existing = await readDefaultRecord()

    if (existing && !options?.force) {
      state.githubToken = existing.accessToken
      if (state.showToken) {
        consola.info("GitHub token:", existing.accessToken)
      }
      await logUser()
      return
    }

    consola.info("Not logged in, requesting a new device code")
    const response = await getDeviceCode()
    consola.debug("Device code response:", response)

    // RFC 8628's `verification_uri_complete` is the only reliable
    // prefill mechanism, but GitHub's device-code endpoint doesn't
    // emit one and their /login/device page doesn't honor a
    // ?user_code= query param either (verified empirically). The
    // user has to type the code into the form. Best we can do for
    // them: copy it to the clipboard automatically so a single
    // Cmd/Ctrl-V completes the flow.
    const verificationUrl =
      response.verification_uri_complete ?? response.verification_uri

    let copiedToClipboard = false
    try {
      clipboard.writeSync(response.user_code)
      copiedToClipboard = true
    } catch {
      // Clipboard unavailable (headless Linux without xclip/xsel,
      // sandboxed environments). Fall through; the next consola.info
      // line tells the user to enter the code manually.
    }

    consola.info(
      copiedToClipboard ?
        `Code ${response.user_code} copied to clipboard — paste into the form, then approve.`
      : `Open the form, then enter code: ${response.user_code}`,
    )

    if (!options?.noBrowser && !isHeadless()) {
      const opened = openUrl(verificationUrl)
      if (opened.ok) {
        consola.info(`(Opened ${verificationUrl} in your browser.)`)
      } else {
        consola.info(
          `(Couldn't open the browser automatically. Visit ${verificationUrl} manually.)`,
        )
      }
    } else {
      consola.info(`Visit ${verificationUrl} in any browser.`)
    }

    const token = await pollAccessToken(response)
    await writeDefaultRecord(makeRecord(token))
    state.githubToken = token

    if (state.showToken) {
      consola.info("GitHub token:", token)
    }
    await logUser()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }

    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

export async function logUser() {
  const user = await getGitHubUser()
  state.userName = user.login
  consola.info(`Logged in as ${user.login}`)
  // Host discovery is NOT done here. The completion host comes solely from
  // setupCopilotToken's /copilot_internal/v2/token mint (the authoritative
  // endpoints.api the bearer is valid against — see applyCopilotApiUrl), which
  // runs right after this on every boot/sign-in and self-heals on refresh.
  // logUser previously also fetched /copilot_internal/user just to re-apply a
  // second, weaker copy of endpoints.api — a redundant round-trip whose value
  // was immediately overwritten by the mint. logUser now owns identity only.
}

/**
 * Re-export so callers that wrote bare-string tokens via PATHS.GITHUB_TOKEN_PATH
 * continue to work. New code should use readGitHubTokenRecord().
 * @public
 */
export const GITHUB_TOKEN_PATH = PATHS.GITHUB_TOKEN_PATH
