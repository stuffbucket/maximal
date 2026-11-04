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
export async function subscribeToQuitRequests(
  onRequest: () => void,
  dependencies: QuitRequestDependencies = defaultDependencies,
): Promise<Unlisten> {
  const consume = async (): Promise<void> => {
    try {
      if (await dependencies.takePending()) onRequest();
    } catch {
      // The settings UI can run in a plain browser during UI development.
    }
  };

  const consumePending = (): void => {
    void consume();
  };
  const unlistenLocal =
    dependencies.subscribeLocal?.(consumePending) ?? (() => {});

  let unlisten: Unlisten;
  try {
    unlisten = await dependencies.subscribe(consumePending);
  } catch {
    // Browser-only UI development has no Tauri event bridge. Still consume once:
    // a native request can already be queued while the remote listener mounts.
    await consume();
    return unlistenLocal;
  }
  await consume();
  return () => {
    unlisten();
    unlistenLocal();
  };
}
