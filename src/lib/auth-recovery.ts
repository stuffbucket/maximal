/**
 * Zero-click auto-recovery.
 *
 * When the active account's credential is rejected by Copilot, instead of
 * dropping the user to a sign-in screen we switch LIVE — in-process, with NO
 * sidecar restart — to another previously-successful account. The user keeps
 * working; the dead account is left flagged `needsReauth` for later.
 *
 * Wired into `auth-controller.markAuthDegraded` via the `registerAutoRecovery`
 * hook (a registration callback, not a static import back into the degrade
 * path) so the token <-> auth-controller module cycle isn't deepened. This
 * module is loaded for its side effect (the registration at the bottom) by a
 * `import "~/lib/auth-recovery"` in bootstrap.
 *
 * Re-entrancy: `switchActiveAccountLive` mints via `setupCopilotToken({
 * onAuthFatal: "throw" })` so a mint failure does NOT call back into
 * markAuthDegraded (which would recurse the sweep). The recovery driver owns
 * the per-candidate degrade decision instead.
 */

import type { AccountRecord } from "./github-token-store"

import { markSignedIn, registerAutoRecovery } from "./auth-controller"
import { preflightCopilotError } from "./copilot-preflight"
import {
  clearNeedsReauth,
  listAccounts,
  markNeedsReauthInDefaultRegistry,
  readDefaultRegistry,
  setActive,
  writeDefaultRegistry,
} from "./github-token-store"
import { createTeeLogger } from "./logger"
import { emitAuthChanged } from "./settings-events"
import { clearLastUpstreamRejection, state } from "./state"
import { setupCopilotToken, stopCopilotRefreshLoop } from "./token"
import { cacheModels } from "./utils"

const log = createTeeLogger("auth")

// Dependency-injection shim for tests, mirroring token.ts / auth-controller.ts:
// a process-wide mock.module for these leaks across sibling test files, so the
// suite overrides them via __setAuthRecoveryDepsForTests instead. Production
// callers see the real implementations.
let setupCopilot: typeof setupCopilotToken = setupCopilotToken
let preflight: typeof preflightCopilotError = preflightCopilotError
let refreshModels: typeof cacheModels = cacheModels

export interface AuthRecoveryTestDeps {
  setupCopilotToken?: typeof setupCopilotToken
  preflightCopilotError?: typeof preflightCopilotError
  cacheModels?: typeof cacheModels
}

export function __setAuthRecoveryDepsForTests(o: AuthRecoveryTestDeps): void {
  if (o.setupCopilotToken !== undefined) setupCopilot = o.setupCopilotToken
  if (o.preflightCopilotError !== undefined) preflight = o.preflightCopilotError
  if (o.cacheModels !== undefined) refreshModels = o.cacheModels
}

export function __resetAuthRecoveryDepsForTests(): void {
  setupCopilot = setupCopilotToken
  preflight = preflightCopilotError
  refreshModels = cacheModels
}

/**
 * Switch the live session onto `rec` without a restart: point in-memory state
 * at its token, mint a fresh Copilot token (+ refresh loop), commit it as the
 * active account on disk, refresh the model catalog, and mark signed-in. The
 * active pointer is only committed to disk AFTER the mint succeeds, so a failed
 * candidate never becomes the boot default. Throws if the mint is rejected.
 */
async function switchActiveAccountLive(
  rec: AccountRecord & { key: string },
): Promise<void> {
  state.githubToken = rec.token
  state.userName = rec.login
  stopCopilotRefreshLoop()

  // onAuthFatal:"throw" — recovery owns the degrade decision; this must NOT
  // re-enter markAuthDegraded (it would recurse this sweep).
  await setupCopilot({ onAuthFatal: "throw" })

  // Mint succeeded → commit: make it active on disk + clear its needs-reauth.
  const reg = await readDefaultRegistry()
  await writeDefaultRegistry(clearNeedsReauth(setActive(reg, rec.key), rec.key))

  // Repopulate the model catalog for the new identity (best-effort; the lazy
  // path refetches on the next request if this transiently fails).
  try {
    await refreshModels()
  } catch (err) {
    log.warn(
      "Auto-recovery: model refresh failed after switch (continuing):",
      err,
    )
  }

  clearLastUpstreamRejection()
  markSignedIn(rec.login)
  emitAuthChanged()
}

/**
 * Try to recover onto a known-good account. Iterates every account that isn't
 * the just-failed active one and isn't already flagged `needsReauth`, preflights
 * each, and live-switches to the first that passes. A candidate that fails
 * preflight or the live mint is itself flagged `needsReauth` and skipped.
 * Returns true if it recovered, false if no account worked.
 */
export async function attemptAutoRecovery(): Promise<boolean> {
  const reg = await readDefaultRegistry()
  const candidates = listAccounts(reg).filter(
    (a) => !a.active && !a.needsReauth,
  )

  for (const cand of candidates) {
    const preErr = await preflight(cand.token, cand.login)
    if (preErr) {
      await markNeedsReauthInDefaultRegistry(cand.key, {
        status: null,
        message: preErr,
        at: new Date().toISOString(),
      })
      continue
    }
    try {
      await switchActiveAccountLive(cand)
      log.info(`Auto-recovery: switched to ${cand.login}.`)
      return true
    } catch (err) {
      // Preflight passed but the live mint failed (TOCTOU). Flag + try next.
      log.warn(
        `Auto-recovery: ${cand.login} failed on live switch; trying next.`,
        err,
      )
      await markNeedsReauthInDefaultRegistry(cand.key, {
        status: null,
        message: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      })
    }
  }

  // No good account. A failed candidate may have populated in-memory token
  // state — clear it so the degraded error state is coherent.
  state.githubToken = undefined
  state.copilotToken = undefined
  state.userName = undefined
  return false
}

registerAutoRecovery(attemptAutoRecovery)
