import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import { t } from "../../../i18n";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { subscribeToQuitRequests } from "./quit-requests";

export function QuitConfirmDialog(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void subscribeToQuitRequests(() => {
      if (!disposed) setOpen(true);
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const confirm = async (): Promise<void> => {
    setBusy(true);
    try {
      await invoke("confirm_quit");
    } catch {
      // If IPC fails, keep the prompt actionable so the user can retry or cancel.
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open={open}
      title={t("native-quit-title")}
      body={<p>{t("native-quit-body")}</p>}
      confirmLabel={t("native-quit-confirm")}
      cancelLabel={t("native-quit-cancel")}
      tone="danger"
      busy={busy}
      onConfirm={confirm}
      onCancel={() => setOpen(false)}
    />
  );
}
