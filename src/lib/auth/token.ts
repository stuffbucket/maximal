import clipboard from "clipboardy"
import consola from "consola"
import { setTimeout as delay } from "node:timers/promises"

import {
  markAuthDegraded as defaultMarkAuthDegraded,
  noteAuthSuccess,
} from "~/lib/auth/auth-controller"
import { toCopilotHost } from "~/lib/auth/auth-types"
import { currentGitHubHost } from "~/lib/auth/github-host"
import {
  addAccountToDefaultRegistry,
  clearActiveNeedsReauthInDefaultRegistry,
  inferTokenType,
  makeAccountRecord,
  readDefaultRecord,
} from "~/lib/auth/github-token-store"
import { getCopilotTokenUrl } from "~/lib/config/api-config"
import { emitAuthChangedWithReconnect } from "~/lib/config/settings-events"
import { CopilotAuthFatalError, HTTPError } from "~/lib/errors/error"
import {
  diagnoseNetworkError,
  formatDiagnosisForLog,
  formatTransportError,
  isTransportError,
  type NetworkDiagnosis,
  NETWORK_SCOPE,
  summarizeTransportError,
} from "~/lib/net/network-diagnostics"
import {
  advanceHysteresis,
  type HysteresisStep,
} from "~/lib/net/network-hysteresis"
import { createTeeLogger } from "~/lib/platform/logger"
import { isHeadless, openUrl } from "~/lib/platform/open-url"
import { PATHS } from "~/lib/platform/paths"
import {
  clearNetworkDiagnosis,
  setCopilotToken,
  setGithubToken,
  setNetworkDiagnosis,
  setUserName,
  state,
} from "~/lib/runtime-state/state"
import { getCopilotToken as defaultGetCopilotToken } from "~/services/github/get-copilot-token"
import {
  type DeviceCodeResponse,
  getDeviceCode,
} from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

// Token/auth events tee to the console AND a dated `auth-*.log` (the same file
// auth-controller writes to) so the device-code flow, Copilot mint, and refresh
// retries are observable after the fact, not just in the dev terminal.
const log = createTeeLogger("auth")

/** Best-effort: the active credential just worked, so clear any stale
 *  needs-reauth flag (a prior transient rejection self-healed). Fire-and-forget
 *  — a flag-clear failure must not add latency to or fail the mint path. */
const clearActiveNeedsReauth = (): void => {
  void clearActiveNeedsReauthInDefaultRegistry().catch((err: unknown) => {
    log.warn("Couldn't clear needs-reauth flag after a successful mint:", err)
  })
}

// Dependency-injection shim for tests, mirroring the pattern in
// `auth-controller.ts`. Process-wide `mock.module` for these symbols
// leaks across test files (Bun's module registry persists for the
// duration of `bun test`); the DI shim keeps the registry untouched
// while still letting `tests/token-auth-fatal.test.ts` observe how
// the refresh loop reacts to CopilotAuthFatalError. Production
// callers see the real implementations.
let getCopilotToken: typeof defaultGetCopilotToken = defaultGetCopilotToken
let markAuthDegraded: typeof defaultMarkAuthDegraded = defaultMarkAuthDegraded

export interface TokenDepsTestOverrides {
  getCopilotToken?: typeof defaultGetCopilotToken
  markAuthDegraded?: typeof defaultMarkAuthDegraded
  /** Override the refresh-loop fatal-retry threshold (default 3). Set to 1 to
   *  drive the escalation path deterministically without waiting out retries. */
  maxFatalRefreshRetries?: number
}

export function __setTokenDepsForTests(
  overrides: TokenDepsTestOverrides,
): void {
  if (overrides.getCopilotToken !== undefined) {
    getCopilotToken = overrides.getCopilotToken
  }
  if (overrides.markAuthDegraded !== undefined) {
    markAuthDegraded = overrides.markAuthDegraded
  }
  if (overrides.maxFatalRefreshRetries !== undefined) {
    maxFatalRefreshRetries = overrides.maxFatalRefreshRetries
  }
}

export function __resetTokenDepsForTests(): void {
  getCopilotToken = defaultGetCopilotToken
  markAuthDegraded = defaultMarkAuthDegraded
  maxFatalRefreshRetries = 3
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
    log.warn(`Ignoring malformed Copilot API host from discovery: ${api}`)
    return
  }
  if (host === state.copilotApiUrl) return
  log.debug(`Copilot API host -> ${host}`)
  state.copilotApiUrl = host
}

export const stopCopilotRefreshLoop = () => {
  if (!copilotRefreshLoopController) {
    return
  }

  copilotRefreshLoopController.abort()
  copilotRefreshLoopController = null
}

export const setupCopilotToken = async (opts?: {
  /**
   * What to do if the FIRST mint hits a CopilotAuthFatalError. Default
   * "degrade" routes it through markAuthDegraded (flag + retain + error state).
   * The auto-recovery path passes "throw" so IT owns the degrade decision —
   * calling markAuthDegraded from inside a recovery sweep would re-enter the
   * sweep and deadlock/clobber it (see auth-recovery.ts).
   */
  onAuthFatal?: "degrade" | "throw"
}) => {
  // Runtime token-type detection: `gho_` tokens (OAuth-App user tokens, e.g.
  // opencode-style or any Ov23li…-prefixed app) are accepted directly by the
  // Copilot edge, don't expire, and need no refresh loop. `ghu_` tokens
  // (GitHub-App user-to-server tokens, our default from Iv1.b507a08c87ecfe98)
  // require the existing /copilot_internal/v2/token exchange + refresh.
  const githubToken = state.githubToken
  if (githubToken && inferTokenType(githubToken) === "gho_") {
    setCopilotToken(githubToken)
    clearActiveNeedsReauth()

    log.debug("Using gho_ token directly as Copilot bearer; no refresh")
    if (state.showToken) {
      // console-only: a raw bearer must never reach the auth-*.log file sink.
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
      // First-mint failure (e.g. user lacks Copilot entitlement, must accept
      // new TOS, or a transient rejection). Degrade NON-DESTRUCTIVELY — flag
      // the account needs-reauth but RETAIN the credential on disk — and
      // surface the reason. Re-throw so the device-flow caller knows the mint
      // failed (it stays in the error state rather than latching signed-in).
      log.warn(
        "Copilot rejected the GitHub token at first mint:",
        error.message,
      )
      if (opts?.onAuthFatal !== "throw") {
        await markAuthDegraded(error)
      }
      throw error
    }
    // Non-auth-fatal first-mint failure. When it's a *transport* failure
    // (device offline / DNS broken / GitHub blocked by compliance/ZTNA), log a
    // readable classification before rethrowing so the caller's "signed-in"
    // attempt records *why* the mint never happened — the device-flow/bootstrap
    // callers only log a generic message. For non-transport errors that generic
    // caller-side line already covers it, so we don't add a duplicate here.
    if (isTransportError(error)) {
      await logRefreshFailure("Copilot token mint failed", error)
    }
    throw error
  }
  setCopilotToken(token)
  clearActiveNeedsReauth()

  log.debug("GitHub Copilot Token fetched successfully!")
  if (state.showToken) {
    // console-only: a raw bearer must never reach the auth-*.log file sink.
    consola.info("Copilot token:", token)
  }

  stopCopilotRefreshLoop()

  const controller = new AbortController()
  copilotRefreshLoopController = controller

  runCopilotRefreshLoop(refresh_in, controller.signal)
    .catch((err: unknown) => {
      // A deliberate abort no longer reaches here (the loop swallows it and
      // resolves), so a rejection is a genuine unexpected fault worth flagging.
      log.error("Copilot token refresh loop crashed unexpectedly:", err)
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
/** Consecutive auth-fatal refresh rejections tolerated before treating the
 *  credential as genuinely bad. A single 401/403 on a refresh is usually
 *  transient (clock skew, a momentary upstream blip, a token-rotation race);
 *  retrying a few times lets it self-heal instead of tearing down the session
 *  on the first hiccup. Mutable so tests can drive the escalation path
 *  deterministically (set to 1) without waiting out real retry delays. */
let maxFatalRefreshRetries = 3

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
  // Count consecutive auth-fatal rejections so a transient 401/403 gets a few
  // bounded retries before we escalate. Reset on any successful refresh.
  let fatalRetries = 0

  while (!signal.aborted) {
    const nextDelayMs = getRefreshPollDelayMs(refreshAtMs)
    if (nextDelayMs > 0) {
      // `delay` REJECTS with an AbortError when the signal fires mid-wait.
      // Aborting is a deliberate teardown (stopCopilotRefreshLoop), not a
      // failure — swallow it and let the `while` guard exit cleanly, so the
      // loop promise resolves instead of surfacing as "refresh loop stopped".
      try {
        await delay(nextDelayMs, undefined, { signal })
      } catch (err) {
        // `delay` rejects with an AbortError when the signal fires — that's a
        // deliberate teardown, so end the loop cleanly. Re-throw anything else.
        if (err instanceof Error && err.name === "AbortError") break
        throw err
      }
      continue
    }

    log.debug("Refreshing Copilot token")

    try {
      const { token, refresh_in, endpoints } = await getCopilotToken()
      setCopilotToken(token)
      applyCopilotApiUrl(endpoints?.api)
      refreshAtMs = getRefreshDeadlineMs(refresh_in)
      if (fatalRetries > 0) clearActiveNeedsReauth()
      fatalRetries = 0
      // A successful refresh proves the credential still works — refresh the
      // grace window so a stale in-flight 401 (or a first request right after
      // wake) doesn't tear the session down, and so the window isn't left
      // stuck at a hours-old sign-in timestamp after a long sleep (P0.4).
      noteAuthSuccess()
      log.debug("Copilot token refreshed")
      // A completed refresh proves connectivity: clear any banner and, if the
      // outage was long enough, fire the reconnect notification.
      noteConnectivityRecovered()
      if (state.showToken) {
        // console-only: a raw bearer must never reach the auth-*.log file sink.
        consola.info("Refreshed Copilot token:", token)
      }
    } catch (error) {
      if (error instanceof CopilotAuthFatalError) {
        fatalRetries++
        if (fatalRetries < maxFatalRefreshRetries) {
          // Probably transient. Retry on the normal cadence before treating
          // the credential as bad — never tear down a session on one 401.
          log.warn(
            `Copilot rejected the GitHub token on refresh (attempt ${fatalRetries}/${maxFatalRefreshRetries}); retrying in ${RETRY_REFRESH_DELAY_MS / 1000}s before treating it as fatal:`,
            error.message,
          )
          refreshAtMs = Date.now() + RETRY_REFRESH_DELAY_MS
          continue
        }
        // Persistent rejection across retries — the GitHub token genuinely
        // can't mint a Copilot token right now. Degrade NON-DESTRUCTIVELY:
        // markAuthDegraded flags the account needs-reauth but RETAINS the
        // credential (no delete, no full sign-out). Exit the loop; a sign-in
        // or account switch spins up a fresh one via setupCopilotToken.
        log.warn(
          `Copilot persistently rejected the GitHub token (${fatalRetries} attempts); degrading without deleting the credential:`,
          error.message,
        )
        // A persistent 401/403 means we DID reach the service (it answered) —
        // that's an auth problem, not a connectivity one, so clear any network
        // banner before degrading.
        noteConnectivityRecovered()
        await markAuthDegraded(error)
        return
      }
      const diagnosis = await logRefreshFailure(
        "Failed to refresh Copilot token",
        error,
      )
      noteConnectivityFailure(diagnosis)
      refreshAtMs = Date.now() + RETRY_REFRESH_DELAY_MS
      log.warn(
        `Retrying Copilot token refresh in ${RETRY_REFRESH_DELAY_MS / 1000}s`,
      )
    }
  }
}

/**
 * Log a non-auth-fatal Copilot-token failure. A *transport* failure (no HTTP
 * status — the socket never completed) is the offline / DNS-broken /
 * scope-unreachable signature: instead of dumping the opaque, fully-redacted
 * `{ code, path, errno }` object, probe what actually works and log the typed
 * classification. Any other error falls back to the raw log. The user-facing
 * message (i18n) is NOT built here — that's the UI's job, keyed on the typed
 * `(kind, scope)` verdict. Best-effort — never throws.
 *
 * Returns the typed `NetworkDiagnosis` when the error was a transport failure we
 * could classify (so the caller can feed it through the banner hysteresis),
 * otherwise null (non-transport error, or the probe itself threw). */
async function logRefreshFailure(
  label: string,
  error: unknown,
): Promise<NetworkDiagnosis | null> {
  if (!isTransportError(error)) {
    log.error(`${label}:`, error)
    return null
  }
  try {
    const diag = await diagnoseNetworkError(error, {
      target: {
        scope: NETWORK_SCOPE.githubCopilotAuth,
        url: getCopilotTokenUrl(),
      },
    })
    // A pre-formatted string arg passes through the file sink's secret-scrubber
    // (not the object redactor), so the safe transport fields stay visible
    // instead of being masked as `[redacted N chars]`. Dev log content — no
    // translation needed.
    log.warn(`${label}: ${formatDiagnosisForLog(diag)}`)
    return diag
  } catch {
    // Diagnosis is telemetry; if the probe itself throws, still record the
    // safe summary so the failure isn't invisible.
    log.warn(
      `${label}: ${formatTransportError(summarizeTransportError(error))}`,
    )
    return null
  }
}

/**
 * Feed a transport failure's diagnosis through the banner hysteresis and update
 * the network-diagnosis signal. Only a diagnosis that has PERSISTED past the
 * onset window promotes to a shown banner (setNetworkDiagnosis(null) is a no-op
 * clear otherwise). Best-effort — never throws. `now` is injectable for tests.
 */
function noteConnectivityFailure(
  diagnosis: NetworkDiagnosis | null,
  now: number = Date.now(),
): void {
  if (!diagnosis) return
  try {
    const { bannerDiagnosis }: HysteresisStep = advanceHysteresis(
      diagnosis,
      now,
    )
    setNetworkDiagnosis(
      bannerDiagnosis ?
        { kind: bannerDiagnosis.kind, scope: bannerDiagnosis.scope }
      : null,
    )
  } catch (err) {
    log.warn("Couldn't update network-diagnosis banner signal:", err)
  }
}

/**
 * Signal that connectivity recovered: feed a null through the hysteresis, clear
 * the banner, and — if the outage lasted long enough — fire the reconnect
 * notification. The sidecar can't fire a native OS notification itself (the
 * Tauri shell owns notifications and reads the flag off the auth.changed
 * payload, same model as last_upstream_rejection), so a qualifying recovery
 * rides a single `notify_on_reconnect: true` event. Best-effort — never throws.
 */
function noteConnectivityRecovered(now: number = Date.now()): void {
  try {
    const { notifyReconnect }: HysteresisStep = advanceHysteresis(null, now)
    clearNetworkDiagnosis()
    if (notifyReconnect) {
      emitAuthChangedWithReconnect()
    }
  } catch (err) {
    log.warn("Couldn't clear network-diagnosis banner signal:", err)
  }
}

interface SetupGitHubTokenOptions {
  force?: boolean
  /** Skip the auto-browser-open step; print the URL/code only. */
  noBrowser?: boolean
}

/**
 * Show the user how to complete a device-code flow: copy the code to the
 * clipboard (best-effort) and open the verification URL (unless noBrowser /
 * headless). Pure UX side-effects — no token state — so it stays out of the
 * token-exchange path in setupGitHubToken.
 */
function presentDeviceCode(
  response: DeviceCodeResponse,
  options?: SetupGitHubTokenOptions,
): void {
  // RFC 8628's `verification_uri_complete` is the only reliable prefill
  // mechanism, but GitHub's device-code endpoint doesn't emit one and their
  // /login/device page doesn't honor a ?user_code= query param either
  // (verified empirically). The user has to type the code into the form. Best
  // we can do: copy it to the clipboard so a single Cmd/Ctrl-V completes it.
  const verificationUrl =
    response.verification_uri_complete ?? response.verification_uri

  let copiedToClipboard = false
  try {
    clipboard.writeSync(response.user_code)
    copiedToClipboard = true
  } catch {
    // Clipboard unavailable (headless Linux without xclip/xsel, sandboxed
    // environments). Fall through; the next log.info tells the user to
    // enter the code manually.
  }

  // console-only: the device user_code is a short-lived pairing credential for
  // the in-progress flow — keep it visible to the user but off the disk sink.
  consola.info(
    copiedToClipboard ?
      `Code ${response.user_code} copied to clipboard — paste into the form, then approve.`
    : `Open the form, then enter code: ${response.user_code}`,
  )

  if (!options?.noBrowser && !isHeadless()) {
    const opened = openUrl(verificationUrl)
    if (opened.ok) {
      log.info(`(Opened ${verificationUrl} in your browser.)`)
    } else {
      log.info(
        `(Couldn't open the browser automatically. Visit ${verificationUrl} manually.)`,
      )
    }
  } else {
    log.info(`Visit ${verificationUrl} in any browser.`)
  }
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const existing = await readDefaultRecord()

    if (existing && !options?.force) {
      setGithubToken(existing.accessToken)
      if (state.showToken) {
        // console-only: a raw token must never reach the auth-*.log file sink.
        consola.info("GitHub token:", existing.accessToken)
      }
      await logUser()
      return
    }

    log.info("Not logged in, requesting a new device code")
    const response = await getDeviceCode()
    log.debug("Device code response:", response)

    presentDeviceCode(response, options)

    const token = await pollAccessToken(response)
    setGithubToken(token)

    if (state.showToken) {
      // console-only: a raw token must never reach the auth-*.log file sink.
      consola.info("GitHub token:", token)
    }

    // Resolve the login best-effort so the account is keyed by its real
    // `login@host`, but never lose the freshly-minted token if the lookup
    // fails — persist regardless (under "unknown" in the worst case).
    let login: string | null = null
    try {
      const user = await getGitHubUser(token)
      login = user.login
      // Single-flight CLI auth; `user` is freshly awaited, no interleaving.
      setUserName(user.login)
    } catch (error) {
      log.warn(
        "Couldn't fetch GitHub user; saving the account as 'unknown'.",
        error,
      )
    }
    await addAccountToDefaultRegistry(
      makeAccountRecord({
        login: login ?? "unknown",
        host: currentGitHubHost(),
        token,
        addedVia: "device-code",
      }),
    )
    log.info(`Logged in as ${login ?? "(unknown)"}`)
  } catch (error) {
    if (error instanceof HTTPError) {
      log.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }

    log.error("Failed to get GitHub token:", error)
    throw error
  }
}

export async function logUser(): Promise<string | undefined> {
  const user = await getGitHubUser()
  setUserName(user.login)
  log.info(`Logged in as ${user.login}`)
  // Host discovery is NOT done here. The completion host comes solely from
  // setupCopilotToken's /copilot_internal/v2/token mint (the authoritative
  // endpoints.api the bearer is valid against — see applyCopilotApiUrl), which
  // runs right after this on every boot/sign-in and self-heals on refresh.
  // logUser previously also fetched /copilot_internal/user just to re-apply a
  // second, weaker copy of endpoints.api — a redundant round-trip whose value
  // was immediately overwritten by the mint. logUser now owns identity only.
  // Hand the avatar URL back so the cold-boot path can pass it to markSignedIn.
  return user.avatar_url
}

/**
 * Re-export so callers that wrote bare-string tokens via PATHS.GITHUB_TOKEN_PATH
 * continue to work. New code should use readGitHubTokenRecord().
 * @public
 */
export const GITHUB_TOKEN_PATH = PATHS.GITHUB_TOKEN_PATH
