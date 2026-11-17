import {
  browserApiKey,
  browserAuthRequired,
  isApiKeyChallenge,
  requireBrowserAuth,
} from "./browser-auth";

export const EVENTS_PATH = "/settings/api/events";

export interface BrowserEventHandlers {
  onEvent: (event: string, data: string) => void;
  /** Every (re)connect, so the caller can resync what it missed. */
  onOpen?: () => void;
  /** Every drop or refused connect. */
  onError?: () => void;
}

export interface BrowserEventOptions {
  /** The key to send; defaults to the tab's saved key. */
  resolveKey?: () => Promise<string | undefined>;
  /** First wait before reconnecting after a network failure or drop. */
  retryDelayMs?: number;
  /** Ceiling the doubling wait never passes. */
  maxRetryDelayMs?: number;
  /** A stream open at least this long counts as healthy: the next drop
   *  starts again from the first wait. */
  stableMs?: number;
  /** Jitter source in [0, 1). Injected for tests. */
  random?: () => number;
  /** Clock and timer, injected for tests. */
  now?: () => number;
  schedule?: (run: () => void, ms: number) => () => void;
}

const DEFAULT_RETRY_MS = 1000;
const DEFAULT_MAX_RETRY_MS = 30_000;

function defaultSchedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
}

/**
 * The wait before reconnect attempt `attempt` (0-based): doubling from
 * `base`, capped at `max`, then jittered down by up to half so many tabs
 * don't reconnect in step.
 */
export function retryDelay(
  attempt: number,
  base: number,
  max: number,
  random: () => number,
): number {
  const ceiling = Math.min(max, base * 2 ** Math.min(attempt, 30));
  return Math.round(ceiling / 2 + (ceiling / 2) * random());
}

/**
 * Incremental parser for `text/event-stream` (the WHATWG SSE format): feed it
 * decoded text as it arrives and it calls `dispatch` once per complete event.
 * Only `event` and `data` matter here; `id`, `retry` and comments are skipped.
 */
export function createEventStreamParser(
  dispatch: (event: string, data: string) => void,
): (chunk: string) => void {
  let buffer = "";
  let event = "";
  let data: Array<string> = [];

  const line = (text: string): void => {
    if (text === "") {
      if (data.length > 0) dispatch(event || "message", data.join("\n"));
      event = "";
      data = [];
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  };

  return (chunk) => {
    buffer += chunk;
    for (;;) {
      const end = /\r\n|\n|\r/.exec(buffer);
      if (!end) return;
      // A lone CR at the end may be the first half of a CRLF still in flight.
      if (end[0] === "\r" && end.index === buffer.length - 1) return;
      line(buffer.slice(0, end.index));
      buffer = buffer.slice(end.index + end[0].length);
    }
  };
}

/**
 * The live event stream for a plain browser. EventSource can't send headers,
 * so it would need the key in the URL; this reads the same stream with
 * `fetch`, keeping the key in `x-api-key`.
 *
 * Like EventSource, an HTTP answer that isn't the stream (any 4xx or 5xx)
 * ends the subscription: retrying wouldn't change it, and callers already
 * fall back to reads. Maximal's key challenge ends it too, and the access
 * dialog takes over (connecting reloads the page). Only a network failure or
 * a stream that drops is retried, after a doubling, capped, jittered wait
 * that starts over once a stream has stayed up. `close()` cancels a pending
 * retry, the request in flight and the stream.
 */
export function subscribeBrowserEvents(
  handlers: BrowserEventHandlers,
  options: BrowserEventOptions = {},
): { close: () => void } {
  const {
    resolveKey = () => Promise.resolve(browserApiKey()),
    retryDelayMs = DEFAULT_RETRY_MS,
    maxRetryDelayMs = DEFAULT_MAX_RETRY_MS,
    stableMs = maxRetryDelayMs,
    random = Math.random,
    now = Date.now,
    schedule = defaultSchedule,
  } = options;
  const controller = new AbortController();
  const closed = (): boolean => controller.signal.aborted;
  let cancelRetry: (() => void) | undefined;
  let attempt = 0;

  /** One connection; says whether a retry could help. */
  const connectOnce = async (): Promise<"retry" | "stop"> => {
    const key = await resolveKey();
    if (closed()) return "stop";
    const response = await fetch(EVENTS_PATH, {
      headers: {
        accept: "text/event-stream",
        ...(key ? { "x-api-key": key } : {}),
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (isApiKeyChallenge(response)) {
      await response.body?.cancel().catch(() => undefined);
      requireBrowserAuth(key);
      // Ignored only when the key was replaced while this request was out:
      // then the current key deserves a try.
      return browserAuthRequired() ? "stop" : "retry";
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return "stop";
    }
    const openedAt = now();
    handlers.onOpen?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const feed = createEventStreamParser(handlers.onEvent);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || closed()) break;
        feed(decoder.decode(value, { stream: true }));
      }
    } finally {
      if (now() - openedAt >= stableMs) attempt = 0;
    }
    return "retry";
  };

  const connect = async (): Promise<void> => {
    cancelRetry = undefined;
    if (closed() || browserAuthRequired()) return;
    let outcome: "retry" | "stop";
    try {
      outcome = await connectOnce();
    } catch {
      // Network failure, or the stream broke mid-read.
      outcome = "retry";
    }
    if (closed()) return;
    handlers.onError?.();
    if (outcome === "stop" || browserAuthRequired()) return;
    const wait = retryDelay(attempt, retryDelayMs, maxRetryDelayMs, random);
    attempt += 1;
    cancelRetry = schedule(() => void connect(), wait);
  };

  void connect();
  return {
    close: () => {
      controller.abort();
      cancelRetry?.();
      cancelRetry = undefined;
    },
  };
}
