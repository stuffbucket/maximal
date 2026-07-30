/**
 * Upstream + secrets bootstrap for `maximal start`.
 *
 * `bootstrapUpstream` brings GitHub Copilot online if a token is
 * already present (disk or --github-token flag). It NEVER fires the
 * device-code flow — that's the Settings UI's job. Errors during
 * Copilot bootstrap are caught: a stale or revoked token shouldn't
 * keep the HTTP server from binding, since the user needs the UI up
 * to re-authenticate. Per ADR-0006: unverifiable sign-in is an
 * error state, never an authenticated-as-unknown one.
 *
 * `bootSecrets` loads file-based provider secrets into process.env
 * once at boot. Env wins; this only populates unset values from
 * `~/.local/share/copilot-api/secrets/<provider>`. Iterates
 * SECRET_DEFS so adding a provider is a one-line change in
 * secrets.ts.
 */

import consola from "consola"

import {
  markAuthDegraded,
  markSignedIn,
  markSignedOut,
  registerAutoRecovery,
} from "~/lib/auth/auth-controller"
// Auto-recovery is parked behind config.autoRecoverAccount (defaults OFF).
// Auto-switching identity needs prior user consent — same plan ≠ same data
// governance — so the registration is gated below and the module is loaded
// lazily only when the user has opted in. Off → degrade + surface the reason.
import { attemptAutoRecovery } from "~/lib/auth/auth-recovery"
import { scheduleCopilotOnlineRetry } from "~/lib/auth/copilot-online-retry"
import { currentGitHubHost } from "~/lib/auth/github-host"
import {
  migrateLegacyRecord,
  readDefaultRecord,
} from "~/lib/auth/github-token-store"
import {
  ensureSecretsDir,
  loadSecretIntoEnv,
  SECRET_DEFS,
} from "~/lib/auth/secrets"
import { logUser, setupCopilotToken } from "~/lib/auth/token"
import { isAutoRecoverAccountEnabled } from "~/lib/config/config"
import { CopilotAuthFatalError } from "~/lib/errors/error"
import { PATHS } from "~/lib/platform/paths"
import { cacheModels } from "~/lib/platform/utils"
import {
  clearTokenTrio,
  hasGithubToken,
  setGithubToken,
  state,
} from "~/lib/runtime-state/state"
import { getGitHubUser } from "~/services/github/get-user"

import { emitBootStatus } from "./boot-status"

export async function bootstrapUpstream(
  githubTokenOverride: string | undefined,
): Promise<void> {
  // Wire the auto-recovery sweep ONLY when the user has opted in
  // (config.autoRecoverAccount, default OFF). Their opt-in is the prior
  // authorization to treat stored accounts as interchangeable; otherwise the
  // hook stays dormant and a fatal rejection degrades + surfaces the reason.
  if (isAutoRecoverAccountEnabled()) {
    registerAutoRecovery(attemptAutoRecovery)
    consola.info("Auto-recover account: enabled")
  }

  if (githubTokenOverride) {
    setGithubToken(githubTokenOverride)
    consola.info("Using provided GitHub token")
  } else {
    // One-time: lift a legacy single-record token into the multi-account
    // registry so a user who signed in before multi-account boots into a
    // properly-keyed active account. Gated (no-op once the registry has
    // accounts); leaves the legacy file as a rollback fallback. Failure here
    // must not block boot — readDefaultRecord still falls back to the legacy
    // file directly.
    await migrateLegacyRecord({
      legacyPath: PATHS.GITHUB_TOKEN_PATH,
      registryPath: PATHS.ACCOUNTS_PATH,
      host: currentGitHubHost(),
      resolveLogin: (token) =>
        getGitHubUser(token)
          .then((user) => user.login)
          .catch(() => null),
    }).catch((error: unknown) => {
      consola.warn("Account registry migration failed (continuing):", error)
      return null
    })
    const existing = await readDefaultRecord()
    if (existing) {
      setGithubToken(existing.accessToken)
      if (state.showToken) {
        consola.info("GitHub token:", existing.accessToken)
      }
    }
  }

  if (hasGithubToken()) {
    // Hoisted so the transient-failure path below can pass it to a late
    // markSignedIn once the background online-retry succeeds.
    let avatarUrl: string | undefined
    try {
      emitBootStatus("Connecting to GitHub Copilot…")
      avatarUrl = await logUser()
      await setupCopilotToken()
      await cacheModels()
      consola.info(
        `Available models: \n${state.models?.data.map((model) => `- ${model.id}`).join("\n")}`,
      )
      // Record the signed-in status so getAuthStatus() reports
      // `authenticated` after a cold boot (the device-flow controller
      // wasn't involved here). logUser() populated state.userName on
      // success above; if it didn't, that's a logUser bug — fall through
      // to the unauthenticated degrade path rather than claim signed-in
      // under an unknown identity.
      if (state.userName) {
        markSignedIn(state.userName, avatarUrl)
        return
      }
      consola.warn(
        "Bootstrap: logUser succeeded but state.userName is empty; degrading to unauthenticated.",
      )
      clearTokenTrio({ github: true, copilot: true })
      markSignedOut()
      return
    } catch (error) {
      // A *fatal* Copilot error (license revoked, TOS not accepted, not
      // entitled) is actionable — but only if we preserve its message +
      // remediation URL. Route it through markAuthDegraded so the Settings
      // "Sign in" screen shows the real reason instead of a generic "Not
      // signed in" that dead-ends the user. markAuthDegraded RETAINS the
      // on-disk credential (flags it needs-reauth), so a transient boot-time
      // rejection self-heals on the next restart rather than forcing re-auth.
      if (error instanceof CopilotAuthFatalError) {
        consola.warn(
          "GitHub token present but Copilot rejected it; surfacing the reason in Settings.",
          error.message,
        )
        await markAuthDegraded(error)
        return
      }
      consola.warn(
        "GitHub token present but Copilot bootstrap failed transiently; keeping the GitHub token and scheduling a background retry.",
        error,
      )
      // The GitHub token is valid — the mint (or model cache) just failed
      // transiently (e.g. GitHub's token endpoint intermittently 5xxing). KEEP
      // the in-memory token so the retry loop can mint with it, and self-heal
      // to signed-in once it succeeds instead of wedging tokenless until a
      // manual restart. Mark signed-out for now so this exit states the union
      // explicitly; the retry flips it back on success.
      markSignedOut()
      scheduleCopilotOnlineRetry({
        onOnline: () => {
          // logUser() runs FIRST at boot and is what sets state.userName, so a
          // transient failure THERE (not in the mint) leaves userName unset.
          // The retry loop only re-mints the Copilot token — it never re-runs
          // logUser — so re-resolve identity here before latching signed-in.
          // Without this, a now-working token would never surface as signed-in
          // and the app would wedge signed-out despite being online.
          void (async () => {
            let avatar = avatarUrl
            if (!state.userName) {
              try {
                avatar = await logUser()
              } catch (err) {
                consola.warn(
                  "Bootstrap online-retry: Copilot came online but the GitHub identity lookup is still failing; staying signed-out until it recovers.",
                  err,
                )
                return
              }
            }
            if (state.userName) markSignedIn(state.userName, avatar)
          })()
        },
      })
    }
  }

  consola.warn(
    "No GitHub token; proxy is up in unauthenticated mode — sign in via /settings or run `maximal auth`.",
  )
}

export function bootSecrets(): void {
  ensureSecretsDir()
  for (const def of SECRET_DEFS) {
    const result = loadSecretIntoEnv({
      envVar: def.envVar,
      fileName: def.fileName,
    })
    if (result.source === "file") {
      consola.info(`Loaded ${def.envVar} from secrets/${def.fileName}`)
    }
  }
}
