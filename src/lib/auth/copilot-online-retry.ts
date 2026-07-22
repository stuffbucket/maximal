import { setTimeout as delay } from "node:timers/promises"

import { CopilotAuthFatalError } from "~/lib/errors/error"
import { createTeeLogger } from "~/lib/platform/logger"
import { cacheModels as defaultCacheModels } from "~/lib/platform/utils"
import { hasGithubToken } from "~/lib/runtime-state/state"

import { setupCopilotToken as defaultSetupCopilotToken } from "./token"

/**
 * Self-healing background retry for a transient FIRST Copilot-token mint failure.
 *
 * The refresh loop in `token.ts` retries mints robustly — but it is only ever
 * spun up AFTER a successful first mint. So a single transient failure at
 * boot/sign-in (e.g. GitHub's `/copilot_internal/v2/token` intermittently
 * 502ing) left the app permanently tokenless with no retry until a manual
 * restart, even after GitHub recovered seconds later. Every request then threw
 * "Copilot token not found".
 *
 * This loop closes that gap: when the initial mint fails transiently, the
 * caller schedules this loop, which keeps re-attempting the mint (and priming
 * the models cache) on a fixed cadence — reusing the same building blocks a
 * fresh boot uses — until it comes online, hits a genuinely auth-fatal error,
 * or the GitHub credential goes away (sign-out / account switch).
 *
 * A successful `setupCopilotToken()` starts the normal refresh loop, so once
 * this loop succeeds it hands off cleanly and stops.
 */

const log = createTeeLogger("auth")

const RETRY_DELAY_MS = 15_000

// Dependency-injection shim for tests, mirroring `token.ts` /
// `auth-controller.ts`. Process-wide `mock.module` for these symbols leaks
// across test files (Bun's module registry persists for a whole `bun test`
// run); the DI shim keeps the registry untouched while letting the retry test
// drive the loop without real network. Production callers see the real impls.
//
// The overrides are NULLABLE with a lazy fallback (dereferenced only inside the
// loop, at call time) ON PURPOSE: `setupCopilotToken` is an exported `const`,
// and this module sits in an import cycle (auth-controller → here → token →
// auth-controller). Capturing the const at module top-level would risk a TDZ
// ReferenceError depending on which module the graph loads first; referencing
// it only after all modules have initialized sidesteps that entirely.
let setupCopilotTokenOverride: typeof defaultSetupCopilotToken | null = null
let cacheModelsOverride: typeof defaultCacheModels | null = null

export interface OnlineRetryDepsTestOverrides {
  setupCopilotToken?: typeof defaultSetupCopilotToken
  cacheModels?: typeof defaultCacheModels
}

export function __setOnlineRetryDepsForTests(
  overrides: OnlineRetryDepsTestOverrides,
): void {
  if (overrides.setupCopilotToken !== undefined) {
    setupCopilotTokenOverride = overrides.setupCopilotToken
  }
  if (overrides.cacheModels !== undefined) {
    cacheModelsOverride = overrides.cacheModels
  }
}

export function __resetOnlineRetryDepsForTests(): void {
  setupCopilotTokenOverride = null
  cacheModelsOverride = null
}

let retryController: AbortController | null = null

export const stopCopilotOnlineRetry = (): void => {
  if (!retryController) return
  retryController.abort()
  retryController = null
}

export interface CopilotOnlineRetryOptions {
  /** Invoked once, when the mint finally succeeds (token + models online). */
  onOnline?: () => void
  /** Override the fixed retry cadence (tests). */
  retryDelayMs?: number
}

/**
 * Start (or restart) the online-retry loop. Idempotent: an in-flight loop is
 * aborted first, so a fresh sign-in never stacks a second loop on top of a
 * boot-time one.
 */
export const scheduleCopilotOnlineRetry = (
  opts: CopilotOnlineRetryOptions = {},
): void => {
  stopCopilotOnlineRetry()

  const controller = new AbortController()
  retryController = controller

  runOnlineRetryLoop(controller.signal, opts)
    .catch((err: unknown) => {
      log.error("Copilot online-retry loop crashed unexpectedly:", err)
    })
    .finally(() => {
      if (retryController === controller) {
        retryController = null
      }
    })
}

const runOnlineRetryLoop = async (
  signal: AbortSignal,
  opts: CopilotOnlineRetryOptions,
): Promise<void> => {
  const retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS
  const setupCopilotToken =
    setupCopilotTokenOverride ?? defaultSetupCopilotToken
  const cacheModels = cacheModelsOverride ?? defaultCacheModels

  while (!signal.aborted) {
    // No GitHub credential means there's nothing to mint with (signed out /
    // switched account). A fresh sign-in schedules its own loop, so just stop.
    if (!hasGithubToken()) {
      log.debug("Copilot online-retry: no GitHub token; stopping")
      return
    }

    try {
      // `delay` REJECTS with an AbortError when the signal fires mid-wait —
      // that's a deliberate teardown (stopCopilotOnlineRetry), so end cleanly.
      await delay(retryDelayMs, undefined, { signal })
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return
      throw err
    }

    // A sign-out during the wait clears the credential; bail before minting.
    // (An abort during the wait already threw AbortError above.)
    if (!hasGithubToken()) return

    try {
      log.info(
        "Retrying Copilot token mint after a transient first-mint failure",
      )
      // On success this ALSO starts the normal refresh loop (token.ts), so the
      // loop hands off cleanly once we're online.
      await setupCopilotToken()
      // Prime the models cache the same way a fresh boot does; the lazy
      // stale-refresh middleware only revalidates an already-primed cache.
      await cacheModels()
      log.info("Copilot came online after a retry")
      opts.onOnline?.()
      return
    } catch (err) {
      if (err instanceof CopilotAuthFatalError) {
        // setupCopilotToken already routed this through markAuthDegraded — the
        // credential genuinely can't mint a Copilot token. Stop retrying.
        log.warn(
          "Copilot online-retry: mint is auth-fatal; stopping:",
          err.message,
        )
        return
      }
      log.warn(
        `Copilot online-retry: mint still failing; retrying in ${retryDelayMs / 1000}s`,
      )
    }
  }
}
