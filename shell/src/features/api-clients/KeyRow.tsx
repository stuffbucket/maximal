import { useCallback, useEffect, useRef, useState } from "react";

import { Checkbox } from "../../ui/Checkbox";
import { Td, Tr } from "../../ui/Table";
import { cx } from "../../ui/cx";
import type { ApiKeyEntry } from "../../../../src/lib/settings-types";
import { SelectCell } from "./SelectCell";
import type { MutationResult } from "./useApiKeys";

interface KeyRowProps {
  entry: ApiKeyEntry;
  selectMode: boolean;
  selected: boolean;
  onToggleSelected: (id: string, next: boolean) => void;
  update: (
    id: string,
    patch: { label?: string; key?: string; enabled?: boolean },
  ) => Promise<MutationResult>;
}

const MASK_CAP = 24;
const COPIED_FLASH_MS = 1200;

function mask(value: string): string {
  const len = Math.min(value.length, MASK_CAP);
  return "•".repeat(len);
}

/**
 * One user-created API key row. Owns its own "is editing the label"
 * and "is the key shown / hidden / just copied" UI state; all
 * persistent state (label / enabled / key value) lives in the parent
 * via the entry prop + the `update` callback.
 */
export function KeyRow({
  entry,
  selectMode,
  selected,
  onToggleSelected,
  update,
}: KeyRowProps): JSX.Element {
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(entry.label);
  const labelInputRef = useRef<HTMLInputElement | null>(null);

  // Resync the draft when the entry's label changes from elsewhere
  // (e.g. after a successful PATCH triggers a reload). Without this,
  // a stale draft would clobber the new authoritative value on next
  // commit.
  useEffect(() => {
    if (!editingLabel) setLabelDraft(entry.label);
  }, [entry.label, editingLabel]);

  useEffect(() => {
    if (editingLabel) labelInputRef.current?.select();
  }, [editingLabel]);

  const commitLabel = useCallback((): void => {
    const next = labelDraft.trim();
    setEditingLabel(false);
    if (!next || next === entry.label) {
      setLabelDraft(entry.label);
      return;
    }
    void update(entry.id, { label: next });
  }, [labelDraft, entry.id, entry.label, update]);

  const onLabelKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitLabel();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setLabelDraft(entry.label);
      setEditingLabel(false);
    }
  };

  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(entry.key);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_FLASH_MS);
    } catch {
      // Clipboard API unavailable (e.g. insecure context). Silent
      // failure is acceptable — the user can still toggle Show and
      // select the text manually.
    }
  };

  return (
    <Tr
      className={cx(selected && "api-keys__row--selected")}
      data-key-id={entry.id}
    >
      <SelectCell
        selectMode={selectMode}
        selectable
        selected={selected}
        onToggle={(next) => onToggleSelected(entry.id, next)}
        ariaLabel={`Select ${entry.label}`}
      />
      <Td>
        <div className="api-keys__cell-key">
          <span
            className={cx(
              "api-keys__key-text mono",
              copied && "api-keys__key-text--copied",
            )}
            role="button"
            tabIndex={0}
            title="Click to copy"
            onClick={() => void onCopy()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                void onCopy();
              }
            }}
          >
            {copied ? "Copied" : showKey ? entry.key : mask(entry.key)}
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setShowKey((v) => !v)}
          >
            {showKey ? "Hide" : "Show"}
          </button>
        </div>
      </Td>
      <Td
        className="api-keys__label"
        data-editing={editingLabel ? "true" : undefined}
        onClick={() => {
          if (!editingLabel) setEditingLabel(true);
        }}
      >
        {editingLabel ? (
          <input
            ref={labelInputRef}
            type="text"
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={onLabelKeyDown}
          />
        ) : (
          entry.label || <span className="muted">Untitled</span>
        )}
      </Td>
      <Td>
        <Checkbox
          checked={entry.enabled}
          onCheckedChange={(next) =>
            void update(entry.id, { enabled: next })
          }
          aria-label={`Enable ${entry.label}`}
        />
      </Td>
    </Tr>
  );
}
