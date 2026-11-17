import {
  browserApiKey,
  browserAuthRequired,
  isApiKeyChallenge,
  requireBrowserAuth,
} from "./browser-auth";

export const EVENTS_PATH = "/settings/api/events";
const RECONNECT_MS = 3000;

export interface BrowserEventHandlers {
  onEvent: (event: string, data: string) => void;
  /** Every (re)connect, so the caller can resync what it missed. */
  onOpen?: () => void;
  /** Every drop or refused connect. */
  onError?: () => void;
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
 * `fetch`, keeping the key in `x-api-key`. Reconnects after a drop like
 * EventSource does, except after Maximal's key challenge: then it stops and
 * the access dialog takes over (connecting reloads the page).
 */
export function subscribeBrowserEvents(
  handlers: BrowserEventHandlers,
  resolveKey: () => Promise<string | undefined> = () =>
    Promise.resolve(browserApiKey()),
): { close: () => void } {
  const controller = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined;

  const connect = async (): Promise<void> => {
    if (controller.signal.aborted || browserAuthRequired()) return;
    try {
      const key = await resolveKey();
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
        if (browserAuthRequired()) {
          handlers.onError?.();
          return;
        }
        // A late challenge for a key that has since been replaced: retry
        // below with the current one.
      } else if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
      } else {
        handlers.onOpen?.();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const feed = createEventStreamParser(handlers.onEvent);
        for (;;) {
          const { done, value } = await reader.read();
          if (done || controller.signal.aborted) break;
          feed(decoder.decode(value, { stream: true }));
        }
      }
    } catch {
      // Dropped or refused: reconnect below unless closed.
    }
    if (controller.signal.aborted || browserAuthRequired()) return;
    handlers.onError?.();
    retry = setTimeout(() => void connect(), RECONNECT_MS);
  };

  void connect();
  return {
    close: () => {
      controller.abort();
      clearTimeout(retry);
    },
  };
}
