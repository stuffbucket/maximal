import { useCallback, useMemo, useState } from "react";

import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Table, Tbody, Th, Thead, Tr } from "../../ui/Table";
import type { ApiKeyEntry } from "../../../../src/lib/settings-types";

import { AddKeyForm } from "./AddKeyForm";
import { KeyRow } from "./KeyRow";
import { WildcardSetting } from "./WildcardSetting";
import { useApiKeys } from "./useApiKeys";

const WILDCARD_KEY = "*";

/**
 * Root of the API-clients island. Per ADR-0002 Option C (the decided
 * direction), the UI shape is:
 *
 *   1. Wildcard is a setting (toggle), not a table row. It's a
 *      different shape of entity (one-of-a-kind, undeletable, lazy-
 *      materialized) and forcing it into a table row required three
 *      conditional branches per row component.
 *   2. User-created keys are a plain list. No "select keys" mode.
 *      Per-row delete via a trailing icon button revealed on hover.
 *      Confirmation modal handles the single-row delete case.
 *   3. Add flow is an inline form below the list, surfaced by clicking
 *      "+ Add API key." Replaces the always-present blank row (which
 *      was undiscoverable without explicit chrome).
 *
 * State this component owns:
 *  - `adding`        — whether the AddKeyForm is currently visible
 *  - `pendingDelete` — null or the entry awaiting confirmation
 *
 * Everything else is hook-driven (useApiKeys).
 */
export function ApiClients(): JSX.Element {
  const { entries, isLoading, error, reload, create, update, remove } =
    useApiKeys();

  const [adding, setAdding] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ApiKeyEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const { wildcard, userEntries } = useMemo(() => {
    let wild: ApiKeyEntry | null = null;
    const users: Array<ApiKeyEntry> = [];
    for (const entry of entries) {
      if (entry.key === WILDCARD_KEY && wild === null) wild = entry;
      else users.push(entry);
    }
    return { wildcard: wild, userEntries: users };
  }, [entries]);

  const onConfirmDelete = useCallback(async (): Promise<void> => {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    await remove(pendingDelete.id);
    await reload();
    setDeleteBusy(false);
    setPendingDelete(null);
  }, [pendingDelete, remove, reload]);

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

      <WildcardSetting
        entry={wildcard}
        create={create}
        update={update}
      />

      <div className="data-table">
        <Table className="table table--api-keys">
          <Thead>
            <Tr>
              <Th scope="col">API Key</Th>
              <Th scope="col">Purpose</Th>
              <Th scope="col">Enabled</Th>
              <Th scope="col" className="sr-only">
                Actions
              </Th>
            </Tr>
          </Thead>
          <Tbody>
            {userEntries.map((entry) => (
              <KeyRow
                key={entry.id}
                entry={entry}
                update={update}
                onDelete={() => setPendingDelete(entry)}
              />
            ))}
          </Tbody>
        </Table>

        {userEntries.length === 0 && !adding && (
          <p className="data-table__empty">
            {isLoading
              ? "Loading…"
              : "No API keys yet. Add one below."}
          </p>
        )}

        <div className="data-table__toolbar">
          {adding ? (
            <AddKeyForm
              create={create}
              onCreated={() => setAdding(false)}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAdding(true)}
            >
              + Add API key
            </Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        tone="danger"
        title="Delete this API key?"
        confirmLabel="Delete"
        busy={deleteBusy}
        body={
          <p>
            Apps using <strong>{pendingDelete?.label}</strong> will
            lose access immediately. This cannot be undone.
          </p>
        }
        onConfirm={onConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
