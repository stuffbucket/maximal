import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"

import type { ApiKeyEntry } from "../../../../../src/lib/config/settings-types"
import type { MutationResult } from "./useApiKeys"

import { Button } from "../../components/Button"
import { Checkbox } from "../../components/Checkbox"
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard"

interface ConnectionCardProps {
  entry: ApiKeyEntry
  update: (
    id: string,
    patch: { label?: string; key?: string; enabled?: boolean },
  ) => Promise<MutationResult>
  onDelete: () => void
}

const MASK_CAP = 24

function mask(value: string): string {
  return "•".repeat(Math.min(value.length, MASK_CAP))
}

// eslint-disable-next-line max-lines-per-function -- cohesive card component; extracting sub-parts would fragment tightly-coupled JSX + handlers.
export function ConnectionCard({
  entry,
  update,
  onDelete,
}: ConnectionCardProps): ReactElement {
  const [showKey, setShowKey] = useState(false)
  const { copied, copy } = useCopyToClipboard()
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(entry.label)
  const nameInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!editingName) setNameDraft(entry.label)
  }, [entry.label, editingName])

  useEffect(() => {
    if (editingName) nameInputRef.current?.select()
  }, [editingName])

  const commitName = useCallback((): void => {
    const next = nameDraft.trim()
    setEditingName(false)
    if (!next || next === entry.label) {
      setNameDraft(entry.label)
      return
    }
    void update(entry.id, { label: next })
  }, [nameDraft, entry.id, entry.label, update])

  let keyText: string
  if (copied) keyText = "Copied"
  else if (showKey) keyText = entry.key
  else keyText = mask(entry.key)

  return (
    <article className="connection-card" data-key-id={entry.id}>
      <header className="connection-card__head">
        <span
          className={
            "connection-card__dot" + (entry.enabled ? " is-active" : "")
          }
          aria-hidden
        />
        {editingName ?
          <input
            ref={nameInputRef}
            type="text"
            className="connection-card__name-input"
            value={nameDraft}
            maxLength={64}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                commitName()
              } else if (e.key === "Escape") {
                e.preventDefault()
                setNameDraft(entry.label)
                setEditingName(false)
              }
            }}
          />
        : <button
            type="button"
            className="connection-card__name"
            onClick={() => setEditingName(true)}
            title="Click to rename"
          >
            {entry.label || <span className="muted">Untitled</span>}
          </button>
        }
        <Button
          variant="ghost"
          size="sm"
          className="connection-card__delete"
          onClick={onDelete}
          aria-label={`Remove ${entry.label}`}
          title="Remove this connection"
        >
          ✕
        </Button>
      </header>

      <div className="connection-card__body">
        <div className="connection-card__field">
          <label className="connection-card__field-label">Connection key</label>
          <div className="connection-card__key">
            <span
              className={
                "connection-card__key-text mono" + (copied ? " is-copied" : "")
              }
            >
              {keyText}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowKey((v) => !v)}
            >
              {showKey ? "Hide" : "Show"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void copy(entry.key)}
            >
              Copy
            </Button>
          </div>
        </div>

        {/* Keep the hand-wrapped label: `.connection-card__enabled` styles the
            On/Off text muted + flex:0-0-auto; Checkbox's own `label` would emit
            `.checkbox-label` (strong color, no flex), a visual regression here. */}
        <label className="connection-card__enabled">
          <Checkbox
            checked={entry.enabled}
            onCheckedChange={(next) => void update(entry.id, { enabled: next })}
            aria-label={`Enable ${entry.label}`}
          />
          <span>{entry.enabled ? "On" : "Off"}</span>
        </label>
      </div>
    </article>
  )
}
