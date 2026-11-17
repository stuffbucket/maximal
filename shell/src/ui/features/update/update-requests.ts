import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * The tray's update action ("Update with apt…") asks Settings to run the
 * update flow by an explicit request: the shell queues it, opens Settings, and
 * signals an already-open window. Nothing infers intent from the page's
 * location, so a persisted or bookmarked System address never prompts.
 */
const UPDATE_REQUESTED_EVENT = "app://update-requested";

type Unlisten = () => void;

export interface UpdateRequestDependencies {
  subscribe: (handler: () => void) => Promise<Unlisten>;
  /** Consume the queued request; true at most once per request. */
  take: () => Promise<boolean>;
}

const defaultDependencies: UpdateRequestDependencies = {
  subscribe: (handler) =>
    listen(UPDATE_REQUESTED_EVENT, () => {
      handler();
    }),
  take: () => invoke<boolean>("take_update_request"),
};

export interface UpdateRequestSubscription {
  ready: Promise<void>;
  unsubscribe: Unlisten;
}

/**
 * Listen first, then take whatever was queued before this page loaded (a
 * window the tray action just created). A signal to an open window takes the
 * queued request too, so a request is acted on once even if both happen.
 */
export function subscribeToUpdateRequests(
  onRequest: () => void,
  dependencies: UpdateRequestDependencies = defaultDependencies,
): UpdateRequestSubscription {
  let disposed = false;
  let unlisten: Unlisten | undefined;

  const takeQueued = async (): Promise<void> => {
    if (disposed) return;
    try {
      if ((await dependencies.take()) && !disposed) onRequest();
    } catch {
      // A plain browser (UI development) has no shell to ask.
    }
  };

  const ready = (async (): Promise<void> => {
    try {
      const stop = await dependencies.subscribe(() => {
        void takeQueued();
      });
      if (disposed) {
        stop();
        return;
      }
      unlisten = stop;
    } catch {
      // No event bridge: still take a request queued before load.
    }
    await takeQueued();
  })();

  return {
    ready,
    unsubscribe: () => {
      disposed = true;
      unlisten?.();
    },
  };
}
