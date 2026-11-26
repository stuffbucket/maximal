/**
 * The bridge between the vanilla update flow (main.ts) and the React dialog
 * that asks the person (UpdateConfirmDialog). The flow awaits an answer; the
 * dialog, once mounted, supplies it. With no dialog mounted the answer is
 * "no", so nothing can update without being asked.
 */
import type { UpdateOffer } from "./update-flow";

export interface UpdateConfirmationRequest {
  offer: UpdateOffer;
  answer: (confirmed: boolean) => void;
}

type Listener = (request: UpdateConfirmationRequest) => void;

let listener: Listener | null = null;

/** Ask the mounted dialog about `offer`. Resolves false without one. */
export function requestUpdateConfirmation(
  offer: UpdateOffer,
): Promise<boolean> {
  const current = listener;
  if (!current) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    current({
      offer,
      answer: (confirmed) => {
        if (settled) return;
        settled = true;
        resolve(confirmed);
      },
    });
  });
}

/** The dialog's subscription. Returns the unsubscribe. */
export function subscribeToUpdateConfirmations(next: Listener): () => void {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}
