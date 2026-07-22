import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Default copied-flash duration, matching the `COPIED_FLASH_MS` value that
 * `ConnectionCard.tsx` (1200ms) and `AppCard.tsx` (1400ms) previously inlined.
 * Callers that need a different flash pass `resetMs` explicitly.
 */
export const COPIED_FLASH_MS = 1200

/** State + action for the "copy then briefly show Copied" pattern. */
export interface UseCopyToClipboard {
  /** True for `resetMs` after a successful copy, then flips back to false. */
  readonly copied: boolean
  /** Copy `text` to the clipboard; sets `copied` only on success. */
  readonly copy: (text: string) => Promise<void>
}

/**
 * Dedups the "copy to clipboard + copied-flash" interaction shared by
 * `ConnectionCard` and `AppCard`. Writes via `navigator.clipboard.writeText`,
 * sets a `copied` flag on success, and clears it after `resetMs`. A failed
 * write (insecure context / clipboard unavailable) is swallowed and leaves
 * `copied` false. The pending reset timeout is cleared on unmount and before
 * each new copy so rapid re-copies don't clip the flash early.
 */
export function useCopyToClipboard(
  resetMs: number = COPIED_FLASH_MS,
): UseCopyToClipboard {
  const [copied, setCopied] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(
    null,
  )

  const clearPending = useCallback((): void => {
    if (timeoutRef.current !== null) {
      globalThis.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  useEffect(() => clearPending, [clearPending])

  const copy = useCallback(
    async (text: string): Promise<void> => {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        // Clipboard unavailable (insecure context / plain browser). Silent —
        // leave `copied` false so the UI shows no false confirmation.
        return
      }
      clearPending()
      setCopied(true)
      timeoutRef.current = globalThis.setTimeout(() => {
        timeoutRef.current = null
        setCopied(false)
      }, resetMs)
    },
    [clearPending, resetMs],
  )

  return { copied, copy }
}
