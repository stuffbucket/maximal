import { useEffect, useState } from "react";

import { ConfirmDialog } from "../../components/ConfirmDialog";

import {
  subscribeToUpdateConfirmations,
  type UpdateConfirmationRequest,
} from "./update-confirm";
import { updateConfirmCopy } from "./update-copy";

/**
 * The one confirmation every Settings update entry point goes through (the
 * title-bar icon, System's Update button, and the tray's apt deep link).
 * Cancel ("Not now") has first focus; Escape and the backdrop cancel too.
 */
export function UpdateConfirmDialog(): JSX.Element {
  const [request, setRequest] = useState<UpdateConfirmationRequest | null>(
    null,
  );

  useEffect(() => subscribeToUpdateConfirmations(setRequest), []);

  const settle = (confirmed: boolean): void => {
    request?.answer(confirmed);
    setRequest(null);
  };

  const copy = request ? updateConfirmCopy(request.offer) : null;
  return (
    <ConfirmDialog
      open={request !== null}
      title={copy?.title ?? ""}
      body={<p>{copy?.body}</p>}
      confirmLabel={copy?.confirmLabel}
      cancelLabel={copy?.cancelLabel}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );
}
