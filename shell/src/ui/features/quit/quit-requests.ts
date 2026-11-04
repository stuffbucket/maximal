import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const QUIT_REQUESTED_EVENT = "app://quit-requested";
const QUIT_REQUESTED_DOM_EVENT = "maximal:quit-requested";

type Unlisten = () => void;

interface QuitRequestDependencies {
  subscribe: (handler: () => void) => Promise<Unlisten>;
  subscribeLocal?: (handler: () => void) => Unlisten;
  hasPending: () => Promise<boolean>;
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
  hasPending: () => invoke<boolean>("has_quit_request"),
};

export async function acknowledgeQuitRequest(): Promise<void> {
  try {
    await invoke<boolean>("take_quit_request");
  } catch {
    // The settings UI can run in a plain browser during UI development.
  }
}

/**
 * Listen before checking the queued request. That ordering closes both races:
 * a request queued before mount is observed immediately, while one arriving
 * during mount is caught by the listener. The dialog acknowledges only after
 * React commits it, so an unmount cannot consume and lose the native request.
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

  const observe = async (): Promise<void> => {
    if (disposed) return;
    try {
      if ((await dependencies.hasPending()) && !disposed) onRequest();
    } catch {
      // The settings UI can run in a plain browser during UI development.
    }
  };

  const observePending = (): void => {
    void observe();
  };
  const unlistenLocal =
    dependencies.subscribeLocal?.(observePending) ?? (() => {});

  const ready = (async (): Promise<void> => {
    try {
      const unlisten = await dependencies.subscribe(observePending);
      if (disposed) {
        unlisten();
        return;
      }
      unlistenRemote = unlisten;
    } catch {
      // Browser-only UI development has no Tauri event bridge. Still check once:
      // a native request can already be queued while the remote listener mounts.
      await observe();
      return;
    }
    await observe();
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
