import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";

import { ConfirmDialog } from "../../ui/ConfirmDialog";

const QUIT_EVENT = "app://quit-requested";

/**
 * Mounted once per Tauri window (Settings). Listens for
 * `app://quit-requested` emitted by the tray's "Quit Maximal" handler,
 * opens a plain confirmation dialog, and on confirm dispatches
 * `invoke('confirm_quit')` which kills the sidecar and exits the
 * process. Does not touch auth state — github_token stays on disk so
 * the next launch is already signed in.
 */
export function QuitConfirmDialog(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen(QUIT_EVENT, () => {
      setOpen(true);
    })
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {
        // Running outside Tauri (e.g. plain vite dev) — no event source.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const onCancel = useCallback(() => {
    if (busy) return;
    setOpen(false);
  }, [busy]);

  const onConfirm = useCallback(async () => {
    setBusy(true);
    try {
      await invoke("confirm_quit");
      // invoke('confirm_quit') resolves never on success — the process
      // exits. We only reach here on failure.
    } catch {
      // Surface failure by closing the dialog and resetting busy. The
      // tray remains available; user can try again.
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }, []);

  return (
    <ConfirmDialog
      open={open}
      title="Quit Maximal?"
      body={<p>Maximal will stop and any open Settings windows will close.</p>}
      confirmLabel="Quit Maximal"
      cancelLabel="Cancel"
      tone="danger"
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
