// Keeps the Dashboard's GitHub quotas (/usage) current without the person
// having to do anything. Every reason to re-read them goes through one entry
// point, `request(trigger)`, which decides from the trigger, the current
// state and the time since the last attempt whether a fetch is due. A failed
// read never replaces what's on screen with an error: the last good snapshot
// stays (shown as out of date) and a backoff timer keeps trying while the
// Dashboard is in view. No DOM, so the root test suite can import it.

/** A good /usage reply and when it arrived. */
export interface UsageSnapshot<T> {
  data: T;
  fetchedAt: number;
}

export type RemoteUsage<T> =
  /** Nothing asked yet. */
  | { status: "idle" }
  | { status: "ready"; snapshot: UsageSnapshot<T> }
  /** The latest read hasn't succeeded (still in flight, or failed): the last
   *  good snapshot if there is one, and the failure for the hover text. */
  | {
      status: "unavailable";
      snapshot: UsageSnapshot<T> | null;
      reason?: string;
    }
  /** /usage answered 401 not_authenticated: the person has to sign in. */
  | { status: "signed-out" };

/**
 * Why a refresh was asked for.
 * - `load`: the page opened.
 * - `auth-changed`: Settings observed a sign-in, sign-out, or account switch;
 *   discard auth-owned state and re-read immediately.
 * - `shown`: the Dashboard view was selected.
 * - `visible`: the window came back into view.
 * - `traffic`: the live token feed saw new requests, so the network is up.
 * - `retry`: the backoff timer after a failure.
 * - `period-ended`: the quotas on screen belong to a period that's over.
 */
export type UsageRefreshTrigger =
  | "load"
  | "auth-changed"
  | "shown"
  | "visible"
  | "traffic"
  | "retry"
  | "period-ended";

/** A good snapshot older than this is worth re-reading on `visible` or
 *  `traffic`. */
export const USAGE_STALE_AFTER_MS = 10 * 60_000;

/** After the nth consecutive failure, wait the nth delay (the last one
 *  repeats) before trying again. Reset by a success or a sign-out. */
export const USAGE_RETRY_DELAYS_MS: ReadonlyArray<number> = [
  30_000, 60_000, 120_000, 300_000,
];

/**
 * The least time since the previous attempt (successful or not) before each
 * trigger may fetch again. Navigation is a deliberate act, so it waits the
 * least: only long enough to absorb flipping between views. Traffic can
 * arrive every half second for as long as apps are busy, so it waits as long
 * as the first backoff step; while GitHub is down but Copilot isn't, that
 * keeps traffic-driven retries to two a minute. The timer and the first load
 * are already paced.
 */
export const USAGE_MIN_GAP_MS: Readonly<Record<UsageRefreshTrigger, number>> = {
  load: 0,
  "auth-changed": 0,
  retry: 0,
  shown: 15_000,
  visible: 15_000,
  traffic: 30_000,
  "period-ended": 60_000,
};

/** The wait after `failures` consecutive failures (`failures` ≥ 1). */
export function usageRetryDelayMs(failures: number): number {
  const index = Math.min(
    Math.max(failures, 1) - 1,
    USAGE_RETRY_DELAYS_MS.length - 1,
  );
  return USAGE_RETRY_DELAYS_MS[index] ?? 0;
}

export interface UsageRefreshContext {
  now: number;
  /** When the previous attempt started; -Infinity before the first. */
  lastAttemptAt: number;
  /** The snapshot on screen belongs to a quota period that has ended. */
  periodEnded: boolean;
}

/** Whether `trigger` should fetch /usage now. */
export function usageRefreshDue<T>(
  trigger: UsageRefreshTrigger,
  usage: RemoteUsage<T>,
  { now, lastAttemptAt, periodEnded }: UsageRefreshContext,
): boolean {
  if (now - lastAttemptAt < USAGE_MIN_GAP_MS[trigger]) return false;
  switch (trigger) {
    case "load":
    case "auth-changed":
    case "shown":
      // Page load, authoritative auth transitions, and deliberate navigation
      // always revalidate. Auth transitions clear their snapshot in request().
      return true;
    case "retry":
      return usage.status === "unavailable";
    case "period-ended":
      return usage.status === "ready" && periodEnded;
    case "visible":
    case "traffic":
      return (
        usage.status !== "ready" ||
        periodEnded ||
        now - usage.snapshot.fetchedAt > USAGE_STALE_AFTER_MS
      );
  }
}

/** The good snapshot on screen, in either state that has one. */
export function shownSnapshot<T>(
  usage: RemoteUsage<T>,
): UsageSnapshot<T> | null {
  return usage.status === "ready" || usage.status === "unavailable"
    ? usage.snapshot
    : null;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface UsageRefresherOptions<T> {
  fetchUsage: (signal: AbortSignal) => Promise<T>;
  /** The reply means "not signed in" (the person has to act). */
  isSignedOut: (error: unknown) => boolean;
  /** One line for the hover text of the "unavailable" status. */
  describeError: (error: unknown) => string;
  /** The Dashboard view is selected and the window is visible. */
  isActive: () => boolean;
  /** `data` belongs to a quota period that has already ended. */
  periodEnded: (data: T) => boolean;
  /** The state changed; re-render. */
  onChange: () => void;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export interface UsageRefresher<T> {
  readonly usage: RemoteUsage<T>;
  /** Fetch /usage if `trigger` is due; resolves when that attempt settles. */
  request: (trigger: UsageRefreshTrigger) => Promise<void>;
  /** The Dashboard came into or went out of view: start or stop the timer. */
  activityChanged: () => void;
}

export function createUsageRefresher<T>(
  options: UsageRefresherOptions<T>,
): UsageRefresher<T> {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));

  let usage: RemoteUsage<T> = { status: "idle" };
  let inFlight: Promise<void> | null = null;
  let abortController: AbortController | null = null;
  let attemptGeneration = 0;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let lastFailureAt = 0;
  let failures = 0;
  let timer: TimerHandle | null = null;

  function stopTimer(): void {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function startTimer(): void {
    stopTimer();
    if (usage.status !== "unavailable" || failures === 0) return;
    if (!options.isActive()) return;
    const wait = Math.max(
      0,
      lastFailureAt + usageRetryDelayMs(failures) - now(),
    );
    timer = setTimer(() => {
      timer = null;
      void request("retry");
    }, wait);
  }

  async function attempt(
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const data = await options.fetchUsage(signal);
      if (generation !== attemptGeneration) return;
      usage = { status: "ready", snapshot: { data, fetchedAt: now() } };
      failures = 0;
    } catch (error) {
      // An auth transition supersedes and aborts the previous account's read.
      // Some fetch implementations reject on abort while others may still
      // settle normally, so the generation is the authority in either case.
      if (generation !== attemptGeneration) return;
      if (options.isSignedOut(error)) {
        usage = { status: "signed-out" };
        failures = 0;
      } else {
        failures += 1;
        lastFailureAt = now();
        usage = {
          status: "unavailable",
          snapshot: shownSnapshot(usage),
          reason: options.describeError(error),
        };
      }
    }
    startTimer();
    options.onChange();
  }

  function request(trigger: UsageRefreshTrigger): Promise<void> {
    const authChanged = trigger === "auth-changed";
    if (inFlight && !authChanged) return inFlight;

    if (authChanged) {
      // Quotas and signed-out state belong to an auth identity. Clear them
      // before fetching so another account's state cannot flash while the
      // authoritative auth transition is revalidated.
      attemptGeneration += 1;
      abortController?.abort();
      abortController = null;
      inFlight = null;
      stopTimer();
      failures = 0;
      lastFailureAt = 0;
      usage = { status: "unavailable", snapshot: null };
      options.onChange();
    }

    const snapshot = shownSnapshot(usage);
    const due = usageRefreshDue(trigger, usage, {
      now: now(),
      lastAttemptAt,
      periodEnded:
        usage.status === "ready" && snapshot !== null
          ? options.periodEnded(snapshot.data)
          : false,
    });
    if (!due) return Promise.resolve();
    lastAttemptAt = now();
    stopTimer();
    // The first read: show the quota layout as "waiting" until it lands.
    const first = usage.status === "idle";
    if (first) usage = { status: "unavailable", snapshot: null };
    const generation = ++attemptGeneration;
    const controller = new AbortController();
    abortController = controller;
    const settled = attempt(generation, controller.signal).finally(() => {
      if (inFlight !== settled) return;
      inFlight = null;
      abortController = null;
    });
    inFlight = settled;
    if (first) options.onChange();
    return settled;
  }

  function activityChanged(): void {
    if (!options.isActive()) stopTimer();
    else if (timer === null && inFlight === null) startTimer();
  }

  return {
    get usage() {
      return usage;
    },
    request,
    activityChanged,
  };
}

/**
 * Tells new traffic from the live token feed's snapshots: the period's
 * request count went up since the previous snapshot of the same period. The
 * first snapshot, and one for a different period, only set the baseline.
 */
export function createTrafficWatch(): (
  period: string,
  requestCount: number | undefined,
) => boolean {
  let last: { period: string; requests: number } | null = null;
  return (period, requestCount) => {
    if (requestCount === undefined || !Number.isFinite(requestCount)) {
      return false;
    }
    const previous = last;
    last = { period, requests: requestCount };
    return (
      previous !== null &&
      previous.period === period &&
      requestCount > previous.requests
    );
  };
}
