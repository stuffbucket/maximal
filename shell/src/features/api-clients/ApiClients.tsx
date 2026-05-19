import { useCallback, useEffect, useState } from "react";

import { apiCall } from "../../api";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import type { ApiKeyEntry } from "../../../../src/lib/settings-types";

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; entries: Array<ApiKeyEntry>; enforcing: boolean }
  | { phase: "error"; message: string };

/**
 * Minimal API-keys management surface. Lists the current keys, lets
 * the user create, toggle enabled, and delete. Delete routes through
 * the reusable ConfirmDialog.
 *
 * Intentionally compact: the original feature module split this into
 * KeyRow / NewKeyRow / WildcardRow, but that split is tangential to
 * the menu-bar-app work — keep one file until a real feature need
 * forces extraction.
 */
export function ApiClients(): JSX.Element {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [pendingDelete, setPendingDelete] = useState<ApiKeyEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [newLabel, setNewLabel] = useState("");

  const refresh = useCallback(async () => {
    const result = await apiCall({
      kind: "api-keys-list",
      method: "GET",
      path: "/settings/api/api-keys",
    });
    if (result.ok) {
      setState({
        phase: "ready",
        entries: result.data.entries,
        enforcing: result.data.enforcing,
      });
    } else {
      setState({ phase: "error", message: result.error });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onCreate = useCallback(async () => {
    const label = newLabel.trim();
    if (!label) return;
    setCreateBusy(true);
    const result = await apiCall({
      kind: "api-keys-create",
      method: "POST",
      path: "/settings/api/api-keys",
      body: { label, enabled: true },
    });
    setCreateBusy(false);
    if (result.ok) {
      setNewLabel("");
      void refresh();
    }
  }, [newLabel, refresh]);

  const onToggle = useCallback(
    async (entry: ApiKeyEntry) => {
      await apiCall({
        kind: "api-keys-update",
        method: "PATCH",
        path: `/settings/api/api-keys/${entry.id}`,
        body: { enabled: !entry.enabled },
      });
      void refresh();
    },
    [refresh],
  );

  const onConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    await apiCall({
      kind: "api-keys-delete",
      method: "DELETE",
      path: `/settings/api/api-keys/${pendingDelete.id}`,
    });
    setDeleteBusy(false);
    setPendingDelete(null);
    void refresh();
  }, [pendingDelete, refresh]);

  if (state.phase === "loading") {
    return <p className="muted">Loading…</p>;
  }
  if (state.phase === "error") {
    return <p className="error">Failed to load API keys: {state.message}</p>;
  }

  return (
    <div className="api-clients">
      <table className="table">
        <thead>
          <tr>
            <th>Label</th>
            <th>Key</th>
            <th>Enabled</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {state.entries.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No keys yet. Any local request is accepted.
              </td>
            </tr>
          )}
          {state.entries.map((entry) => (
            <tr key={entry.id}>
              <td>{entry.label}</td>
              <td>
                <code>{maskKey(entry.key)}</code>
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={entry.enabled}
                  onChange={() => void onToggle(entry)}
                />
              </td>
              <td>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setPendingDelete(entry)}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="api-clients__new">
        <input
          type="text"
          placeholder="New key label (e.g. Claude Code)"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          disabled={createBusy}
        />
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void onCreate()}
          disabled={createBusy || !newLabel.trim()}
        >
          Create key
        </button>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete API key?"
        body={
          <p>
            Delete API key{" "}
            <strong>“{pendingDelete?.label ?? ""}”</strong>? Apps using this
            key will lose access immediately.
          </p>
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        tone="danger"
        busy={deleteBusy}
        onConfirm={onConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

function maskKey(key: string): string {
  if (key === "*") return "* (wildcard)";
  if (key.length <= 8) return key;
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
