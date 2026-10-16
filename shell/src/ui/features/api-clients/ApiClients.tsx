import { useCallback, useState } from "react";

import { Button } from "../../components/Button";
import { ProblemCallout } from "../../components/ProblemCallout";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { Stack } from "../../components/Stack";
import type { ApiKeyEntry } from "../../../../../src/lib/config/settings-types";

import { AddConnection } from "./AddConnection";
import { AdvancedSection } from "./AdvancedSection";
import { ConnectionCard } from "./ConnectionCard";
import { useApiKeys } from "./useApiKeys";

export function ApiClients(): JSX.Element {
  const {
    entries,
    enforcing,
    isLoading,
    problem,
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
    <Stack proximity="region" className="api-clients">
      {problem && (
        <ProblemCallout
          problem={problem}
          onRetry={() => void reload()}
          onRestarted={() => void reload()}
        />
      )}

      <Stack proximity="section" className="connection-list">
        {entries.map((entry) => (
          <ConnectionCard
            key={entry.id}
            entry={entry}
            update={update}
            onDelete={() => setPendingDelete(entry)}
          />
        ))}

        {showEmpty && !problem && (
          <EmptyState title="No connections yet" compact>
            <p>
              Add a connection for each app you want to recognize — Claude
              Code, Cursor, anything else. Each one gets its own key, so its
              traffic is labeled.
            </p>
          </EmptyState>
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
      </Stack>

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
    </Stack>
  );
}
