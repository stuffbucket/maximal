import { NoticeDialog } from "../../components/NoticeDialog";

import { desktopRestartCopy, type DesktopChange } from "./desktop-restart";

interface DesktopRestartDialogProps {
  /** The applied change to explain, or null when closed. */
  change: DesktopChange | null;
  onDismiss: () => void;
}

/** Shown after Claude Desktop routing was actually turned on or off. */
export function DesktopRestartDialog({
  change,
  onDismiss,
}: DesktopRestartDialogProps): JSX.Element {
  const copy = desktopRestartCopy(change ?? "disabled");
  return (
    <NoticeDialog
      open={change !== null}
      title={copy.title}
      actionLabel={copy.action}
      onDismiss={onDismiss}
    >
      <p>{copy.body}</p>
      {copy.note && <p>{copy.note}</p>}
    </NoticeDialog>
  );
}
