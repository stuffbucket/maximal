import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const QUIT_REQUESTED_EVENT = "app://quit-requested";

type Unlisten = () => void;

interface QuitRequestDependencies {
  subscribe: (handler: () => void) => Promise<Unlisten>;
  takePending: () => Promise<boolean>;
}

const defaultDependencies: QuitRequestDependencies = {
  subscribe: (handler) =>
    listen(QUIT_REQUESTED_EVENT, () => {
      handler();
    }),
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

  let unlisten: Unlisten;
  try {
    unlisten = await dependencies.subscribe(() => {
      void consume();
    });
  } catch {
    // Browser-only UI development has no Tauri event bridge.
    return () => {};
  }
  await consume();
  return unlisten;
}
