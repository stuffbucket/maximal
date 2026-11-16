import { events } from "fetch-event-stream";

import { browserApiKey, browserAuthRequired, isApiKeyChallenge, requireBrowserAuth } from "./browser-auth";

interface Handlers {
  onEvent: (event: string, data: string) => void;
  onOpen?: () => void;
  onError?: () => void;
}

/** Fetch-based SSE: unlike EventSource, it keeps browser credentials in headers. */
export function subscribeBrowserEvents(
  handlers: Handlers,
  resolveKey: () => Promise<string | undefined> = () => Promise.resolve(browserApiKey()),
): { close: () => void } {
  const controller = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined;

  const connect = async (): Promise<void> => {
    if (controller.signal.aborted || browserAuthRequired()) return;
    try {
      const key = await resolveKey();
      const response = await fetch("/settings/api/events", {
        headers: { accept: "text/event-stream", ...(key ? { "x-api-key": key } : {}) },
        signal: controller.signal,
        cache: "no-store",
      });
      if (isApiKeyChallenge(response)) {
        await response.body?.cancel();
        requireBrowserAuth(key);
        if (browserAuthRequired()) {
          handlers.onError?.();
          return;
        }
        // A delayed challenge for an old credential must reconnect with the new one.
        throw new Error("Event stream credential changed");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Event stream unavailable");
      }
      handlers.onOpen?.();
      for await (const event of events(response, controller.signal)) {
        if (controller.signal.aborted) return;
        handlers.onEvent(event.event ?? "message", event.data ?? "");
      }
    } catch {
      if (controller.signal.aborted) return;
    }
    if (!controller.signal.aborted && !browserAuthRequired()) {
      handlers.onError?.();
      retry = setTimeout(() => { void connect(); }, 3000);
    }
  };

  void connect();
  return {
    close: () => {
      controller.abort();
      clearTimeout(retry);
    },
  };
}
