import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";

import { apiCall, type ActiveApiClient } from "../../api";
import { ConfirmDialog } from "../../ui/ConfirmDialog";

const QUIT_EVENT = "app://quit-requested";

type State =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; clients: Array<ActiveApiClient>; total: number }
  | { phase: "error" };

/**
 * Mounted once per Tauri window (Settings + Dashboard). Listens for
 * `app://quit-requested` emitted by the tray's "Quit Maximal" handler,
 * opens the confirm dialog, queries the proxy for active clients,
 * and on confirm dispatches `invoke('confirm_quit')` which kills the
 * sidecar and exits the process.
 */
export function QuitConfirmDialog(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ phase: "idle" });
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

  // Fetch active clients lazily on each open. The list can change
  // between confirmations and we don't want stale state from a
  // dialog that was opened minutes ago.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ phase: "loading" });
    apiCall({
      kind: "active-clients",
      method: "GET",
      path: "/settings/api/clients?maxAgeSeconds=60",
    })
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setState({
            phase: "ready",
            clients: result.data.clients,
            total: result.data.total,
          });
        } else {
          setState({ phase: "error" });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ phase: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

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
      body={renderBody(state)}
      confirmLabel="Quit Maximal"
      cancelLabel="Cancel"
      tone="danger"
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

function renderBody(state: State): JSX.Element {
  if (state.phase === "loading") {
    return <p>Checking active connections…</p>;
  }
  if (state.phase === "error") {
    return (
      <>
        <p>
          Quitting will stop forwarding Copilot requests. Any currently
          connected apps will be disconnected.
        </p>
      </>
    );
  }
  if (state.phase === "idle") {
    return <p>Quitting will stop forwarding Copilot requests.</p>;
  }
  const labels = pickLabels(state.clients);
  if (state.total === 0 || labels.length === 0) {
    return (
      <p>
        No apps are currently connected. You can quit safely — the proxy
        will stop forwarding Copilot requests.
      </p>
    );
  }
  if (state.total === 1) {
    return (
      <p>
        One app is currently using Maximal: <strong>{labels[0]}</strong>.
        Quitting will disconnect it.
      </p>
    );
  }
  // 2+ clients: show up to 3 labels, then "and N more".
  const head = labels.slice(0, 3);
  const remaining = state.total - head.length;
  const list = head.map((l, i) => (
    <strong key={`${l}-${i}`}>{i > 0 ? ", " : ""}{l}</strong>
  ));
  return (
    <p>
      {state.total} apps are currently using Maximal: {list}
      {remaining > 0 ? ` and ${remaining} more` : ""}. Quitting will
      disconnect them.
    </p>
  );
}

function pickLabels(clients: Array<ActiveApiClient>): Array<string> {
  const seen = new Set<string>();
  const out: Array<string> = [];
  for (const c of clients) {
    const label = c.label?.trim();
    if (!label) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}
