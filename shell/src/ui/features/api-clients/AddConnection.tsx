import { type ReactElement, useEffect, useRef, useState } from "react"

import type { MutationResult } from "./useApiKeys"

import { Button } from "../../components/Button"

interface AddConnectionProps {
  create: (input: {
    label: string
    key?: string
    enabled?: boolean
  }) => Promise<MutationResult>
  onDone: () => void
}

export function AddConnection({
  create,
  onDone,
}: AddConnectionProps): ReactElement {
  const [label, setLabel] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    nameInputRef.current?.focus()
  }, [])

  const submit = async (): Promise<void> => {
    const trimmed = label.trim()
    if (!trimmed) {
      setError("Give this connection a name first.")
      return
    }
    setBusy(true)
    setError(null)
    const result = await create({ label: trimmed, enabled: true })
    setBusy(false)
    if (!result.ok) {
      setError(result.error ?? "Couldn't add this connection.")
      return
    }
    onDone()
  }

  return (
    <form
      className="add-connection"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <label className="add-connection__field">
        <span className="add-connection__field-label">
          What's this connection for?
        </span>
        <input
          ref={nameInputRef}
          type="text"
          className="input"
          placeholder="e.g. Claude Code, Cursor, Raycast"
          value={label}
          disabled={busy}
          maxLength={64}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault()
              onDone()
            }
          }}
          aria-label="Connection name"
        />
        <span className="add-connection__hint">
          We'll generate a key for you. You can copy it once the connection
          shows up below.
        </span>
      </label>
      {error && (
        <p className="state__caption state__caption--error" role="alert">
          {error}
        </p>
      )}
      <div className="add-connection__actions">
        <Button variant="ghost" size="sm" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          type="submit"
          disabled={busy || label.trim().length === 0}
        >
          Add connection
        </Button>
      </div>
    </form>
  )
}
