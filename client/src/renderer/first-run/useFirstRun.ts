import { useEffect, useMemo, useRef, useState } from 'react'

import {
  createFirstRunCapabilities,
  type AuthCapability,
  type AuthStatus,
  type BootPhase,
} from './capabilities'
import { deriveFirstRunPhase, type ActionError, type FirstRunPhase } from './model'

/** How often we re-derive `remainingMs` for the countdown and re-check
 *  client-side expiry while a device code is pending. 1s matches the
 *  granularity `formatRemaining` displays (mm:ss). */
const TICK_MS = 1_000

/** Fallback poll interval for auth status, mirroring the pre-existing
 *  pattern in `renderer/main.tsx`: `subscribe()` is the fast path (reacts to
 *  control-plane push events), this is the safety net for a missed or
 *  renamed event. */
const POLL_MS = 3_000

function classifyActionError(error: unknown): ActionError {
  const message = error instanceof Error ? error.message : String(error)
  return /network|fetch|offline|unreachable|ECONNREFUSED|timeout/i.test(message)
    ? { kind: 'offline', message }
    : { kind: 'fatal', message }
}

export interface UseFirstRunResult {
  phase: FirstRunPhase
  /** True while a `signIn`/`restart`/`signOut` call is in flight. Screens use
   *  this to disable their primary action rather than hide it — a control a
   *  keyboard/screen-reader user just activated should not vanish out from
   *  under focus. */
  busy: boolean
  signIn: () => void
  /** Same underlying call as `signIn` — `auth/start` is idempotent while a
   *  flow is active and issues a fresh code once the previous one has
   *  expired (see `auth-controller.ts`). Kept as a separate name because the
   *  two are semantically distinct actions to a user (starting fresh vs.
   *  recovering from an expired code), even though today they resolve to the
   *  same call. */
  restart: () => void
  signOut: () => void
  openVerificationUrl: (url: string) => void
}

/**
 * Wires the first-run capability seam into React state, and is the one
 * place `FirstRunPhase` gets computed from live inputs (see `model.ts` for
 * the pure derivation). Resumability lives here: on mount this reads
 * whatever `auth/status` and the boot capability report RIGHT NOW — a
 * device flow already pending, a code already expired, an account already
 * signed in from a previous run — rather than assuming a fresh start.
 */
export function useFirstRun(): UseFirstRunResult {
  const [boot, setBoot] = useState<BootPhase>({ phase: 'starting' })
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [actionError, setActionError] = useState<ActionError | null>(null)
  const [busy, setBusy] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const authRef = useRef<AuthCapability | null>(null)

  useEffect(() => {
    let cancelled = false
    let unsubAuth = () => {}
    let unsubLifecycle = () => {}
    let poll: ReturnType<typeof setInterval> | null = null

    const capabilities = createFirstRunCapabilities()
    authRef.current = capabilities.auth

    setBoot(capabilities.lifecycle.current())
    unsubLifecycle = capabilities.lifecycle.subscribe((next) => {
      if (!cancelled) setBoot(next)
    })

    const refresh = async () => {
      try {
        const next = await capabilities.auth.status()
        if (!cancelled) {
          setStatus(next)
          // A successful read supersedes any earlier action error — the
          // control plane has spoken again since, which is a more current
          // signal than a stale failure from a previous action.
          setActionError(null)
        }
      } catch {
        // Transient — the poll/subscribe fallback below will retry. A
        // *user-initiated* action failure is surfaced via setActionError in
        // signIn/restart/signOut instead; a background refresh miss stays
        // quiet rather than interrupting whatever the user is looking at.
      }
    }

    void refresh()
    unsubAuth = capabilities.auth.subscribe(() => void refresh())
    poll = setInterval(() => void refresh(), POLL_MS)

    return () => {
      cancelled = true
      unsubAuth()
      unsubLifecycle()
      if (poll) clearInterval(poll)
      // Tears down both `onCoreStatus` bridge listeners this mount's
      // capability bundle registered (`auth`'s and `lifecycle`'s). Without
      // this, every mount — including every sign-out, which remounts
      // `FirstRun` — left a fresh pair of listeners nothing would ever
      // remove (review finding M4).
      capabilities.dispose()
    }
  }, [])

  // Tick the clock while a device code is live so client-side expiry
  // (`deriveFirstRunPhase`'s `remainingMs <= 0` check) fires on its own,
  // without waiting for the next poll/subscribe event.
  useEffect(() => {
    if (status?.state !== 'device_code_issued' && status?.state !== 'polling') return
    const timer = setInterval(() => setNowMs(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [status?.state])

  const phase = useMemo(
    () => deriveFirstRunPhase({ boot, status, actionError, nowMs }),
    [boot, status, actionError, nowMs],
  )

  function runAction(action: (auth: AuthCapability) => Promise<AuthStatus | void>) {
    const auth = authRef.current
    if (!auth || busy) return
    setBusy(true)
    setActionError(null)
    void action(auth)
      .then((next) => {
        if (next) setStatus(next)
      })
      .catch((error: unknown) => {
        setActionError(classifyActionError(error))
      })
      .finally(() => setBusy(false))
  }

  return {
    phase,
    busy,
    signIn: () => runAction((auth) => auth.start()),
    restart: () => runAction((auth) => auth.start()),
    signOut: () =>
      runAction(async (auth) => {
        await auth.signOut()
        return auth.status()
      }),
    openVerificationUrl: (url: string) => {
      void authRef.current?.openExternal(url)
    },
  }
}
