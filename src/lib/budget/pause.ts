/**
 * Requests held at a `pause` rule's limit.
 *
 * A request that finds a pause rule at its limit isn't refused: it waits here
 * until the limit is cleared (its period turned over, it was raised, an
 * approval overrode it) or someone resumes or cancels it, up to a maximum
 * wait; the caller re-checks the budget each time `park` returns. A request
 * whose client went away leaves at once, and only so many are held at a
 * time. Pure bookkeeping plus timers: nothing here knows about HTTP.
 */

export type ParkOutcome =
  /** Look again: time passed, or something changed. */
  | "recheck"
  /** Let it through whatever the budget says (a person resumed it once). */
  | "resumed"
  /** Fail it: the person cancelled the paused requests. */
  | "cancelled"
  /** The maximum wait ran out. */
  | "timeout"
  /** The caller's client went away. */
  | "aborted"

export const DEFAULT_RECHECK_MS = 2000
export const DEFAULT_MAX_HELD = 50

export interface PauseGateDeps {
  /** How long a held request waits between looks (ms). */
  recheckMs?: number
  /** At most this many held at once. */
  maxHeld?: () => number
  /** Told when the held count changes. */
  onChange?: () => void
}

/** One held request. It counts as held until `release`. */
export interface HeldRequest {
  /** Wait until the next recheck, a wake, the deadline (an epoch ms, read
   *  with `now`) or the client going away. A wake that came while the
   *  request wasn't waiting is delivered at once. */
  park(options: {
    deadlineMs: number
    signal?: AbortSignal
    now?: () => number
  }): Promise<ParkOutcome>
  release(): void
}

export interface PauseGate {
  /** Hold a request at a limit; undefined when too many are held already. */
  enter(limitId: string): HeldRequest | undefined
  /** How many are held at a limit, or in all. */
  heldCount(limitId?: string): number
  /** Which limits have held requests. */
  heldLimits(): Array<string>
  /** Wake the held requests to look again. */
  recheck(limitId?: string): number
  /** Let the held requests through whatever the budget says. */
  resume(limitId?: string): number
  /** Fail the held requests. */
  cancel(limitId?: string): number
}

interface Entry {
  limitId: string
  /** Set while the request is waiting in `park`. */
  wake?: (outcome: ParkOutcome) => void
  /** A wake that arrived between waits. */
  pending?: ParkOutcome
}

export function createPauseGate(deps: PauseGateDeps = {}): PauseGate {
  const recheckMs = deps.recheckMs ?? DEFAULT_RECHECK_MS
  const maxHeld = deps.maxHeld ?? (() => DEFAULT_MAX_HELD)
  const held = new Set<Entry>()

  function signal(limitId: string | undefined, outcome: ParkOutcome): number {
    let reached = 0
    for (const entry of held) {
      if (limitId !== undefined && entry.limitId !== limitId) continue
      reached += 1
      if (entry.wake) entry.wake(outcome)
      // Cancelling or resuming outranks looking again.
      else if (entry.pending === undefined || outcome !== "recheck") {
        entry.pending = outcome
      }
    }
    return reached
  }

  return {
    enter(limitId) {
      if (held.size >= maxHeld()) return undefined
      const entry: Entry = { limitId }
      held.add(entry)
      deps.onChange?.()
      let released = false
      return {
        park({ deadlineMs, signal: abort, now = Date.now }) {
          return new Promise<ParkOutcome>((resolve) => {
            if (entry.pending !== undefined) {
              const outcome = entry.pending
              entry.pending = undefined
              resolve(outcome)
              return
            }
            if (abort?.aborted) {
              resolve("aborted")
              return
            }
            const remaining = deadlineMs - now()
            if (remaining <= 0) {
              resolve("timeout")
              return
            }
            const finish = (outcome: ParkOutcome): void => {
              clearTimeout(timer)
              abort?.removeEventListener("abort", onAbort)
              entry.wake = undefined
              resolve(outcome)
            }
            const onAbort = (): void => {
              finish("aborted")
            }
            const timer = setTimeout(
              () => {
                finish(now() >= deadlineMs ? "timeout" : "recheck")
              },
              Math.min(recheckMs, remaining),
            )
            entry.wake = finish
            abort?.addEventListener("abort", onAbort, { once: true })
          })
        },
        release() {
          if (released) return
          released = true
          held.delete(entry)
          deps.onChange?.()
        },
      }
    },

    heldCount(limitId) {
      if (limitId === undefined) return held.size
      let n = 0
      for (const entry of held) if (entry.limitId === limitId) n += 1
      return n
    },
    heldLimits: () => [...new Set([...held].map((entry) => entry.limitId))],
    recheck: (limitId) => signal(limitId, "recheck"),
    resume: (limitId) => signal(limitId, "resumed"),
    cancel: (limitId) => signal(limitId, "cancelled"),
  }
}
