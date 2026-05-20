import { useEffect, useRef, useState } from "react";

import { Button } from "../../ui/Button";
import { Checkbox } from "../../ui/Checkbox";
import type { MutationResult } from "./useApiKeys";

interface AddKeyFormProps {
  create: (input: {
    label: string;
    key?: string;
    enabled?: boolean;
  }) => Promise<MutationResult>;
  onCreated: () => void;
  onCancel: () => void;
}

/**
 * Inline form for adding a new API key. Replaces the always-present
 * blank row from the prior pattern — only renders when the user
 * clicks "+ Add API key." Esc cancels, Enter submits.
 *
 * The Key field is optional: blank == auto-generate, `*` == wildcard
 * (handled by the proxy as a special case), otherwise must match
 * API_KEY_VALUE_PATTERN. The Purpose label is required so the user
 * has a way to remember why a key exists.
 */
export function AddKeyForm({
  create,
  onCreated,
  onCancel,
}: AddKeyFormProps): JSX.Element {
  const [keyValue, setKeyValue] = useState("");
  const [label, setLabel] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const labelInputRef = useRef<HTMLInputElement | null>(null);

  // Land focus on the human field (Purpose) — Key is optional and
  // most users will skip it. Different from the prior always-present
  // blank row that focused Key first.
  useEffect(() => {
    labelInputRef.current?.focus();
  }, []);

  const submit = async (): Promise<void> => {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      setLocalError("Purpose is required.");
      return;
    }
    setBusy(true);
    setLocalError(null);
    const result = await create({
      label: trimmedLabel,
      key: keyValue.trim() || undefined,
      enabled,
    });
    setBusy(false);
    if (result.ok) {
      onCreated();
    } else {
      setLocalError(result.error ?? "Failed to add API key.");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <form
      className="add-key-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="add-key-form__row">
        <input
          ref={labelInputRef}
          type="text"
          className="input"
          placeholder="Purpose (e.g. Claude Code)"
          value={label}
          disabled={busy}
          maxLength={64}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Purpose"
        />
        <input
          type="text"
          className="input mono"
          placeholder="Key (blank to auto-generate)"
          value={keyValue}
          disabled={busy}
          onChange={(e) => setKeyValue(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Key value"
        />
        <label className="checkbox-label">
          <Checkbox
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={busy}
            aria-label="Enabled"
          />
          Enabled
        </label>
      </div>
      {localError && (
        <p className="state__caption state__caption--error" role="alert">
          {localError}
        </p>
      )}
      <div className="add-key-form__actions">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          type="submit"
          disabled={busy || label.trim().length === 0}
        >
          Add key
        </Button>
      </div>
    </form>
  );
}
