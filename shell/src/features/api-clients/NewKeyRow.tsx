import { useEffect, useRef, useState } from "react";

import { Checkbox } from "../../ui/Checkbox";
import { Td, Tr } from "../../ui/Table";
import { cx } from "../../ui/cx";
import type { MutationResult } from "./useApiKeys";

interface NewKeyRowProps {
  selectMode: boolean;
  /** Returns the create result so the parent can decide whether to
   *  remount this row (bump newRowKey) on success. */
  create: (input: {
    label: string;
    key?: string;
    enabled?: boolean;
  }) => Promise<MutationResult>;
  onCommitted: () => void;
}

/**
 * Always-present blank row at the bottom of the table. Three inline
 * inputs: API Key, Purpose, Enabled. Tab cycles forward; tabbing past
 * the Enabled checkbox commits and asks the parent to remount via a
 * key bump (resetting our local state). Enter on any field commits.
 * Esc clears.
 *
 * The component owns no parent state — when the parent's `newRowKey`
 * changes, React unmounts us, useState reinitializes, and the cursor
 * lands back in the API Key input via the autoFocus ref dance.
 */
export function NewKeyRow({
  selectMode,
  create,
  onCommitted,
}: NewKeyRowProps): JSX.Element {
  const [keyValue, setKeyValue] = useState("");
  const [label, setLabel] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const keyInputRef = useRef<HTMLInputElement | null>(null);

  // When the parent re-keys us we mount fresh; focus the API Key
  // input so the user can type immediately. Without this, after Tab-
  // past-Enabled the focus would land somewhere unpredictable.
  useEffect(() => {
    keyInputRef.current?.focus();
  }, []);

  const commit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const result = await create({
      label: label.trim(),
      key: keyValue.trim() ? keyValue.trim() : undefined,
      enabled,
    });
    setBusy(false);
    if (result.ok) {
      onCommitted();
    }
  };

  const reset = (): void => {
    setKeyValue("");
    setLabel("");
    setEnabled(true);
  };

  const onKeyboard =
    (handler: (e: React.KeyboardEvent<HTMLInputElement>) => void) =>
    (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commit();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        reset();
        return;
      }
      handler(e);
    };

  return (
    <Tr className="api-keys__row--new">
      <Td
        className={cx(
          "api-keys__select-col",
          !selectMode && "api-keys__select-col--hidden",
        )}
      >
        {/* Nothing to select on the blank row yet. */}
      </Td>
      <Td>
        <input
          ref={keyInputRef}
          type="text"
          className="api-keys__inline-input mono"
          placeholder="Auto-generate"
          value={keyValue}
          disabled={busy}
          onChange={(e) => setKeyValue(e.target.value)}
          onKeyDown={onKeyboard(() => {})}
        />
      </Td>
      <Td>
        <input
          type="text"
          className="api-keys__inline-input"
          placeholder="What is this for?"
          value={label}
          disabled={busy}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={onKeyboard(() => {})}
        />
      </Td>
      <Td>
        <Checkbox
          checked={enabled}
          onCheckedChange={setEnabled}
          disabled={busy}
          aria-label="Enable new key"
          onKeyDown={(e) => {
            // Tab past Enabled = commit + spawn next row. Shift+Tab
            // goes back to the Purpose input, which is the native
            // default — leave it alone.
            if (e.key === "Tab" && !e.shiftKey) {
              e.preventDefault();
              void commit();
            } else if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              reset();
            }
          }}
        />
      </Td>
    </Tr>
  );
}
