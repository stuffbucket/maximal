/**
 * Refreshing a provider's allowance on demand, instead of waiting for one of
 * its replies to carry it. A provider that can say implements
 * `refreshQuotaWindows()` (`UpstreamProvider`); this asks it, hands what it
 * reports to the provider-windows registry, and keeps one ask per provider
 * from following another within `REFRESH_MIN_INTERVAL_MS`.
 */

import type { UpstreamProvider } from "@stuffbucket/maximal-plugin-sdk/gateway"

import consola from "consola"

import type { ProviderQuotaWindow } from "./provider-windows"

/** One refresh per provider in this long, whoever asks (the window's button,
 *  a script, the one at startup). */
export const REFRESH_MIN_INTERVAL_MS = 30_000

export type RefreshResult =
  | { ok: true; windows: number }
  | { ok: false; reason: "unknown-provider" }
  | { ok: false; reason: "unsupported" }
  | { ok: false; reason: "rate-limited"; retryAfterSeconds: number }
  | { ok: false; reason: "failed"; message: string }

export interface AllowanceRefresherDeps {
  /** The provider with this id, if there is one. */
  provider(
    id: string,
  ): Pick<UpstreamProvider, "refreshQuotaWindows"> | undefined
  /** Record what the provider reported. */
  observe(windows: ReadonlyArray<ProviderQuotaWindow>): void
  clock?: () => number
}

export interface AllowanceRefresher {
  refresh(providerId: string): Promise<RefreshResult>
}

export function createAllowanceRefresher(
  deps: AllowanceRefresherDeps,
): AllowanceRefresher {
  const clock = deps.clock ?? Date.now
  const lastAskedMs = new Map<string, number>()

  return {
    async refresh(providerId) {
      const provider = deps.provider(providerId)
      if (!provider) return { ok: false, reason: "unknown-provider" }
      if (!provider.refreshQuotaWindows)
        return { ok: false, reason: "unsupported" }

      const nowMs = clock()
      const last = lastAskedMs.get(providerId) ?? Number.NEGATIVE_INFINITY
      if (nowMs - last < REFRESH_MIN_INTERVAL_MS) {
        return {
          ok: false,
          reason: "rate-limited",
          retryAfterSeconds: Math.ceil(
            (REFRESH_MIN_INTERVAL_MS - (nowMs - last)) / 1000,
          ),
        }
      }
      // Counted when asked, not when answered: a provider that is failing
      // isn't asked again at once.
      lastAskedMs.set(providerId, nowMs)

      try {
        const windows = await provider.refreshQuotaWindows()
        deps.observe(windows)
        return { ok: true, windows: windows.length }
      } catch (error) {
        consola.debug(`Could not refresh the ${providerId} allowance`, error)
        return {
          ok: false,
          reason: "failed",
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}
