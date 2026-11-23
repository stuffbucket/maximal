/**
 * Converge a signed-out or degraded sidecar onto the registry's active account.
 *
 * `maximal auth` runs in another process and writes its sign-in to
 * accounts.json. Without this watcher a running sidecar never sees it and keeps
 * serving unauthenticated until restarted. A signed-in session is never
 * touched: switching a working identity stays the user's call.
 */

import type {
  AccountRecord,
  AccountRegistry,
} from "~/lib/auth/github-token-store"

import {
  type AuthStateKind,
  getAuthStateKind,
  markAuthDegraded,
} from "~/lib/auth/auth-controller"
import { switchActiveAccountLive } from "~/lib/auth/auth-recovery"
import {
  getActiveRecord,
  readDefaultRegistry,
} from "~/lib/auth/github-token-store"
import { CopilotAuthFatalError } from "~/lib/errors/http-errors"
import { createTeeLogger } from "~/lib/platform/logger"
import { clearTokenTrio } from "~/lib/runtime-state/state"

const log = createTeeLogger("auth")

type ActiveAccount = AccountRecord & { key: string }

const isAdoptable = (kind: AuthStateKind) =>
  kind === "signed-out" || kind === "error"

function activeAccount(reg: AccountRegistry): ActiveAccount | null {
  const rec = getActiveRecord(reg)
  return rec && reg.activeKey ? { ...rec, key: reg.activeKey } : null
}

export function pickAdoption(input: {
  authKind: AuthStateKind
  active: ActiveAccount | null
  lastAttemptedToken: string | null
}): ActiveAccount | null {
  const { authKind, active, lastAttemptedToken } = input
  if (!isAdoptable(authKind) || !active || active.needsReauth) return null
  return active.token === lastAttemptedToken ? null : active
}

let lastAttemptedToken: string | null = null
let inFlight: Promise<void> | null = null
let timer: ReturnType<typeof setInterval> | null = null

async function adopt(rec: ActiveAccount): Promise<void> {
  try {
    await switchActiveAccountLive(rec)
    log.info(`Picked up a new sign-in for ${rec.login} from accounts.json.`)
  } catch (error) {
    if (error instanceof CopilotAuthFatalError) {
      await markAuthDegraded(error)
      return
    }
    log.warn(
      `Couldn't use the new sign-in for ${rec.login} from accounts.json:`,
      error,
    )
    clearTokenTrio()
  }
}

async function adoptFromRegistry(): Promise<void> {
  const rec = pickAdoption({
    authKind: getAuthStateKind(),
    active: activeAccount(await readDefaultRegistry()),
    lastAttemptedToken,
  })
  if (!rec) return
  // Recorded before the attempt so a failing token is tried once, not every tick.
  lastAttemptedToken = rec.token
  await adopt(rec)
}

export function tickRegistryAdoption(): Promise<void> {
  if (!inFlight && isAdoptable(getAuthStateKind())) {
    inFlight = adoptFromRegistry().finally(() => {
      inFlight = null
    })
  }
  return inFlight ?? Promise.resolve()
}

export function stopRegistryAdoption(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** Seeds the boot-time active token as already attempted, then polls. */
export async function startRegistryAdoption(opts?: {
  intervalMs?: number
}): Promise<() => void> {
  stopRegistryAdoption()
  lastAttemptedToken = activeAccount(await readDefaultRegistry())?.token ?? null
  timer = setInterval(() => {
    tickRegistryAdoption().catch((error: unknown) => {
      log.warn("Registry adoption tick failed:", error)
    })
  }, opts?.intervalMs ?? 3000)
  timer.unref()
  return stopRegistryAdoption
}
