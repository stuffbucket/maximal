/**
 * Auto-recovery onto a known-good account.
 *
 * ⚠️ OFF BY DEFAULT — parked behind `config.autoRecoverAccount`. bootstrap only
 * registers this sweep with markAuthDegraded when that flag is on; otherwise the
 * hook stays dormant and the proxy never auto-switches identity.
 *
 * Why gated: switching accounts is a governance decision the user must authorize
 * in advance. Two accounts on the SAME plan can sit under different data
 * governance (tenancy, residency, retention, audit), so "same plan" is not a
 * safe proxy for "interchangeable". Enabling the flag IS that prior consent.
 * With it off, a fatal rejection degrades non-destructively (credential retained
 * + flagged needsReauth) and surfaces the reason / a notification that
 * deep-links to the Settings sign-in page — the user picks. (A future
 * refinement pairs the enacted switch with a seamless, no-drop restart rather
 * than the live in-process mutation here.)
 *
 * Re-entrancy: `attemptAutoRecovery` preflights each non-flagged account and
 * enacts via `switchActiveAccountLive`, which mints with `setupCopilotToken({
 * onAuthFatal: "throw" })` so a mint failure doesn't recurse the sweep.
 */

import type { AccountRecord } from "./github-token-store"

import { markSignedIn } from "./auth-controller"
import { preflightCopilotError } from "./copilot-preflight"
import {
  activateAndClearNeedsReauthInDefaultRegistry,
  listAccounts,
  markNeedsReauthInDefaultRegistry,
  readDefaultRegistry,
} from "./github-token-store"
import { createTeeLogger } from "./logger"
import { emitAuthChanged } from "./settings-events"
import {
  clearLastUpstreamRejection,
  clearTokenTrio,
  setGithubToken,
  setUserName,
} from "./state"
import { setupCopilotToken, stopCopilotRefreshLoop } from "./token"
import { cacheModels } from "./utils"

const log = createTeeLogger("auth")

/** Flag a candidate that couldn't be recovered onto (preflight or live-mint
 *  failure); status is null because neither path yields an HTTP code here. */
const flagBad = (key: string, message: string) =>
  markNeedsReauthInDefaultRegistry(key, {
    status: null,
    message,
    at: new Date().toISOString(),
  })

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
  setGithubToken(rec.token)
  setUserName(rec.login)
  stopCopilotRefreshLoop()

  // onAuthFatal:"throw" — recovery owns the degrade decision; this must NOT
  // re-enter markAuthDegraded (it would recurse this sweep).
  await setupCopilot({ onAuthFatal: "throw" })

  // Mint succeeded → commit: make it active on disk + clear its needs-reauth.
  await activateAndClearNeedsReauthInDefaultRegistry(rec.key)

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
      await flagBad(cand.key, preErr)
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
      await flagBad(cand.key, err instanceof Error ? err.message : String(err))
    }
  }

  // No good account. A failed candidate may have populated in-memory token
  // state — clear it so the degraded error state is coherent.
  clearTokenTrio()
  return false
}

// No auto-registration at module load. bootstrap calls
// registerAutoRecovery(attemptAutoRecovery) ONLY when config.autoRecoverAccount
// is enabled (the user's prior authorization) — see the module header.
