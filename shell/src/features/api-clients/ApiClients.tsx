import { useCallback, useState } from "react";

import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import type { ApiKeyEntry } from "../../../../src/lib/settings-types";

import { AddConnection } from "./AddConnection";
import { AdvancedSection } from "./AdvancedSection";
import { ConnectionCard } from "./ConnectionCard";
import { useApiKeys } from "./useApiKeys";

export function ApiClients(): JSX.Element {
  const {
    entries,
    enforcing,
    isLoading,
    error,
    reload,
    create,
    update,
    remove,
    setEnforce,
  } = useApiKeys();

  const [adding, setAdding] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ApiKeyEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const onConfirmDelete = useCallback(async (): Promise<void> => {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    await remove(pendingDelete.id);
    await reload();
    setDeleteBusy(false);
    setPendingDelete(null);
  }, [pendingDelete, remove, reload]);

  const showEmpty = !isLoading && entries.length === 0 && !adding;

  return (
    <div className="api-clients">
      {error && (
        <p
          className="state__caption state__caption--error"
          role="alert"
        >
          {error}
        </p>
      )}

      <div className="connection-list">
        {entries.map((entry) => (
          <ConnectionCard
            key={entry.id}
            entry={entry}
            update={update}
            onDelete={() => setPendingDelete(entry)}
          />
        ))}

        {showEmpty && (
          <p className="connection-list__empty">
            Nothing here yet. Add a connection for each app you want to
            recognize — Claude Code, Cursor, anything else.
          </p>
        )}

        {adding ? (
          <AddConnection
            create={create}
            onDone={() => setAdding(false)}
          />
        ) : (
          <div className="connection-list__add">
            <Button
              variant="primary"
              size="sm"
              onClick={() => setAdding(true)}
            >
              + Add a connection
            </Button>
          </div>
        )}
      </div>

      <AdvancedSection
        enforcing={enforcing}
        setEnforce={setEnforce}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        tone="danger"
        title="Remove this connection?"
        confirmLabel="Remove"
        busy={deleteBusy}
        body={
          <p>
            <strong>{pendingDelete?.label}</strong> will no longer show up
            on this list. You can always add it back later.
          </p>
        }
        onConfirm={onConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
