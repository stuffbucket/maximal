import { useCallback, useEffect, useMemo, useState } from "react";

import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Table, Tbody, Th, Thead, Tr } from "../../ui/Table";
import { cx } from "../../ui/cx";
import type { ApiKeyEntry } from "../../../../src/lib/settings-types";

import { KeyRow } from "./KeyRow";
import { NewKeyRow } from "./NewKeyRow";
import { Toolbar } from "./Toolbar";
import { WildcardRow } from "./WildcardRow";
import { useApiKeys } from "./useApiKeys";

const WILDCARD_KEY = "*";
const SECTION_HASH = "#api-clients";
const DELETE_PREVIEW_MAX = 3;

/**
 * Root of the API-clients island. Owns the four pieces of UI state
 * that don't belong on a child:
 *
 *  - `selectMode`           — does the Select column show?
 *  - `selectedIds`          — Set<string> of user-row IDs to delete
 *  - `newRowKey`            — bump to remount the blank row after
 *                              a successful POST (component-keyed reset)
 *  - `confirmingDelete`     — confirm dialog visibility + busy state
 *
 * Everything wire-level (entries, enforcing, errors) comes from
 * useApiKeys(). The hash-nav reset effect lives here, not on a child,
 * so leaving the section guarantees a clean re-entry.
 */
export function ApiClients(): JSX.Element {
  const { entries, isLoading, error, reload, create, update, remove } =
    useApiKeys();

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [newRowKey, setNewRowKey] = useState(0);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Hash-nav reset: leaving #api-clients drops select mode + the
  // selection set, so re-entering the section starts clean. Listen
  // on the window object, not the host element — hashchange only
  // fires there.
  useEffect(() => {
    const onHashChange = (): void => {
      if (window.location.hash !== SECTION_HASH) {
        setSelectMode(false);
        setSelectedIds(new Set());
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Splitting the entries into the wildcard slot vs. user rows lets
  // the table render in a fixed order without prepending/sorting on
  // every render. `useMemo` because `entries` is the most-rerendered
  // dep on the page and splitting it isn't free.
  const { wildcard, userEntries } = useMemo(() => {
    let wild: ApiKeyEntry | null = null;
    const users: Array<ApiKeyEntry> = [];
    for (const entry of entries) {
      if (entry.key === WILDCARD_KEY && wild === null) {
        wild = entry;
      } else {
        users.push(entry);
      }
    }
    return { wildcard: wild, userEntries: users };
  }, [entries]);

  const onToggleSelected = useCallback(
    (id: string, next: boolean): void => {
      setSelectedIds((prev) => {
        const out = new Set(prev);
        if (next) out.add(id);
        else out.delete(id);
        return out;
      });
    },
    [],
  );

  const onSelectModeChange = useCallback((next: boolean): void => {
    setSelectMode(next);
    if (!next) setSelectedIds(new Set());
  }, []);

  const onCommitted = useCallback((): void => {
    // Bumping the key remounts NewKeyRow, which resets its draft
    // state and auto-focuses the API Key input again.
    setNewRowKey((k) => k + 1);
  }, []);

  const onConfirmDelete = useCallback(async (): Promise<void> => {
    setDeleteBusy(true);
    // Sequential fan-out so we don't hammer the proxy and so a
    // partial failure leaves a coherent state (we still reload at
    // the end regardless).
    for (const id of selectedIds) {
      // eslint-disable-next-line no-await-in-loop
      await remove(id);
    }
    await reload();
    setDeleteBusy(false);
    setConfirmingDelete(false);
    setSelectedIds(new Set());
  }, [selectedIds, remove, reload]);

  // Build a friendly preview of "Foo, Bar, Baz and 2 more" for the
  // confirm body. Order from `userEntries` keeps it deterministic
  // even when Set iteration order would be insertion-ordered.
  const selectedLabels = useMemo(() => {
    const labels: Array<string> = [];
    for (const entry of userEntries) {
      if (selectedIds.has(entry.id)) labels.push(entry.label || "Untitled");
    }
    return labels;
  }, [userEntries, selectedIds]);

  const selectedCount = selectedIds.size;

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
      <div className="data-table">
        <Table className="table table--api-keys">
          <Thead>
            <Tr>
              <Th
                scope="col"
                className={cx(
                  "api-keys__select-col",
                  !selectMode && "api-keys__select-col--hidden",
                )}
              >
                <span className="sr-only">Select</span>
              </Th>
              <Th scope="col">API Key</Th>
              <Th scope="col">Purpose</Th>
              <Th scope="col">Enabled</Th>
            </Tr>
          </Thead>
          <Tbody>
            <WildcardRow
              entry={wildcard}
              selectMode={selectMode}
              create={create}
              update={update}
            />
            {userEntries.map((entry) => (
              <KeyRow
                key={entry.id}
                entry={entry}
                selectMode={selectMode}
                selected={selectedIds.has(entry.id)}
                onToggleSelected={onToggleSelected}
                update={update}
              />
            ))}
            <NewKeyRow
              key={`new-${newRowKey}`}
              selectMode={selectMode}
              create={create}
              onCommitted={onCommitted}
            />
          </Tbody>
        </Table>
        {isLoading && entries.length === 0 && (
          <p className="data-table__empty">Loading…</p>
        )}
        <Toolbar
          selectMode={selectMode}
          selectedCount={selectedCount}
          onSelectModeChange={onSelectModeChange}
          onDeleteRequest={() => setConfirmingDelete(true)}
        />
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        tone="danger"
        title="Delete API keys?"
        confirmLabel={`Delete ${selectedCount}`}
        busy={deleteBusy}
        body={
          <>
            <p>
              You're about to delete {selectedCount} API key
              {selectedCount === 1 ? "" : "s"}. Apps using{" "}
              {selectedCount === 1 ? "this key" : "these keys"} will lose
              access immediately.
            </p>
            <ul>
              {selectedLabels.slice(0, DELETE_PREVIEW_MAX).map((label) => (
                <li key={label}>{label}</li>
              ))}
              {selectedLabels.length > DELETE_PREVIEW_MAX && (
                <li className="muted">
                  …and {selectedLabels.length - DELETE_PREVIEW_MAX} more
                </li>
              )}
            </ul>
          </>
        }
        onConfirm={onConfirmDelete}
        onCancel={() => setConfirmingDelete(false)}
      />
    </div>
  );
}
