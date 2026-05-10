import consola from "consola"
import { setTimeout as delay } from "node:timers/promises"

import { PATHS } from "~/lib/paths"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { HTTPError } from "./error"
import {
  inferTokenType,
  makeRecord,
  readDefaultRecord,
  writeDefaultRecord,
} from "./github-token-store"
import { isHeadless, openUrl } from "./open-url"
import { setCopilotToken, state } from "./state"

let copilotRefreshLoopController: AbortController | null = null

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

  const { token, refresh_in } = await getCopilotToken()
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
      const { token, refresh_in } = await getCopilotToken()
      setCopilotToken(token)
      refreshAtMs = getRefreshDeadlineMs(refresh_in)
      consola.debug("Copilot token refreshed")
      if (state.showToken) {
        consola.info("Refreshed Copilot token:", token)
      }
    } catch (error) {
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

    // GitHub accepts a `user_code` query parameter on the verification URL
    // and pre-fills the input field, dropping a copy/paste step. The
    // `verification_uri_complete` field on RFC 8628 responses provides the
    // canonical URL when the server supports it; fall back to manual
    // composition (GitHub's verification_uri is `https://github.com/login/device`).
    const completeUrl = buildVerificationUrl(response)

    consola.info(
      `Open ${completeUrl} in your browser and approve. Code: ${response.user_code}`,
    )

    if (!options?.noBrowser && !isHeadless()) {
      const opened = openUrl(completeUrl)
      if (opened.ok) {
        consola.info("(Opened your default browser.)")
      } else {
        consola.info(
          "(Couldn't open the browser automatically. Visit the URL manually.)",
        )
      }
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

function buildVerificationUrl(response: {
  verification_uri: string
  verification_uri_complete?: string
  user_code: string
}): string {
  if (response.verification_uri_complete) {
    return response.verification_uri_complete
  }
  const url = new URL(response.verification_uri)
  url.searchParams.set("user_code", response.user_code)
  return url.toString()
}

export async function logUser() {
  const user = await getGitHubUser()
  state.userName = user.login
  consola.info(`Logged in as ${user.login}`)

  const copilotUser = await getCopilotUsage()
  state.copilotApiUrl = copilotUser.endpoints.api
}

/**
 * Re-export so callers that wrote bare-string tokens via PATHS.GITHUB_TOKEN_PATH
 * continue to work. New code should use readGitHubTokenRecord().
 * @public
 */
export const GITHUB_TOKEN_PATH = PATHS.GITHUB_TOKEN_PATH
