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
  markAuthFatalAndSignOut,
  markSignedIn,
  markSignedOut,
} from "~/lib/auth-controller"
import { CopilotAuthFatalError } from "~/lib/error"
import { currentGitHubHost } from "~/lib/github-host"
import {
  migrateLegacyRecord,
  readDefaultRecord,
} from "~/lib/github-token-store"
import { PATHS } from "~/lib/paths"
import { ensureSecretsDir, loadSecretIntoEnv, SECRET_DEFS } from "~/lib/secrets"
import { state } from "~/lib/state"
import { logUser, setupCopilotToken } from "~/lib/token"
import { cacheModels } from "~/lib/utils"
import { getGitHubUser } from "~/services/github/get-user"

import { emitBootStatus } from "./boot-status"

export async function bootstrapUpstream(
  githubTokenOverride: string | undefined,
): Promise<void> {
  if (githubTokenOverride) {
    state.githubToken = githubTokenOverride
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
      state.githubToken = existing.accessToken
      if (state.showToken) {
        consola.info("GitHub token:", existing.accessToken)
      }
    }
  }

  if (state.githubToken) {
    try {
      emitBootStatus("Connecting to GitHub Copilot…")
      await logUser()
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
        markSignedIn(state.userName)
        return
      }
      consola.warn(
        "Bootstrap: logUser succeeded but state.userName is empty; degrading to unauthenticated.",
      )
      state.githubToken = undefined
      state.copilotToken = undefined
      markSignedOut()
      return
    } catch (error) {
      // A *fatal* Copilot error (license revoked, TOS not accepted, not
      // entitled) is actionable — but only if we preserve its message +
      // remediation URL. Route it through markAuthFatalAndSignOut so the
      // Settings "Sign in" screen shows the real reason instead of a generic
      // "Not signed in" that dead-ends the user. Non-fatal/transient errors
      // keep the plain warn-and-degrade path (the token may still be good;
      // the proxy stays up so the user can retry or re-auth).
      if (error instanceof CopilotAuthFatalError) {
        consola.warn(
          "GitHub token present but Copilot rejected it; surfacing the reason in Settings.",
          error.message,
        )
        await markAuthFatalAndSignOut(error)
        return
      }
      consola.warn(
        "GitHub token present but Copilot bootstrap failed; serving in unauthenticated mode.",
        error,
      )
      // Clear the in-memory token but keep the on-disk record for a
      // next-restart retry, and set the union explicitly (signed-out) so
      // every bootstrap exit makes its own auth-status statement.
      state.githubToken = undefined
      markSignedOut()
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
