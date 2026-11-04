import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const QUIT_REQUESTED_EVENT = "app://quit-requested";
const QUIT_REQUESTED_DOM_EVENT = "maximal:quit-requested";

type Unlisten = () => void;

interface QuitRequestDependencies {
  subscribe: (handler: () => void) => Promise<Unlisten>;
  subscribeLocal?: (handler: () => void) => Unlisten;
  takePending: () => Promise<boolean>;
}

const defaultDependencies: QuitRequestDependencies = {
  subscribe: (handler) =>
    listen(QUIT_REQUESTED_EVENT, () => {
      handler();
    }),
  subscribeLocal: (handler) => {
    const eventTarget = globalThis as {
      addEventListener: (type: string, listener: () => void) => void;
      removeEventListener: (type: string, listener: () => void) => void;
    };
    eventTarget.addEventListener(QUIT_REQUESTED_DOM_EVENT, handler);
    return () =>
      eventTarget.removeEventListener(QUIT_REQUESTED_DOM_EVENT, handler);
  },
  takePending: () => invoke<boolean>("take_quit_request"),
};

/**
 * Listen before consuming the queued request. That ordering closes both races:
 * a request queued before mount is consumed immediately, while one arriving
 * during mount is caught by the listener and consumed exactly once.
 */
interface QuitRequestSubscription {
  ready: Promise<void>;
  unsubscribe: Unlisten;
}

export function subscribeToQuitRequests(
  onRequest: () => void,
  dependencies: QuitRequestDependencies = defaultDependencies,
): QuitRequestSubscription {
  let disposed = false;
  let unlistenRemote: Unlisten | undefined;

  const consume = async (): Promise<void> => {
    if (disposed) return;
    try {
      if ((await dependencies.takePending()) && !disposed) onRequest();
    } catch {
      // The settings UI can run in a plain browser during UI development.
    }
  };

  const consumePending = (): void => {
    void consume();
  };
  const unlistenLocal =
    dependencies.subscribeLocal?.(consumePending) ?? (() => {});

  const ready = (async (): Promise<void> => {
    try {
      const unlisten = await dependencies.subscribe(consumePending);
      if (disposed) {
        unlisten();
        return;
      }
      unlistenRemote = unlisten;
    } catch {
      // Browser-only UI development has no Tauri event bridge. Still consume once:
      // a native request can already be queued while the remote listener mounts.
      await consume();
      return;
    }
    await consume();
  })();

  return {
    ready,
    unsubscribe: () => {
      disposed = true;
      unlistenLocal();
      unlistenRemote?.();
    },
  };
}
