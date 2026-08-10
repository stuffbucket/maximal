import { useState, type ReactElement } from 'react'

import { spellOutCode } from './model'

// The device-code display: the code itself, rendered two ways at once —
// visually as one glanceable string, and for assistive tech as explicitly
// spelled-out discrete characters (task requirement: a screen reader must
// not attempt to pronounce the code as one mangled word). Plus a
// copy-to-clipboard button with its own polite confirmation, so a keyboard
// or screen-reader user doesn't have to select text by hand to get the code
// into GitHub's field.

interface DeviceCodeProps {
  code: string
}

export function DeviceCode({ code }: DeviceCodeProps): ReactElement {
  const [copied, setCopied] = useState(false)

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 4000)
    } catch {
      // Clipboard access can be denied by the OS/permissions; the code is
      // still visible and selectable by hand, so this is a degrade, not a
      // dead end.
    }
  }

  return (
    <div className="first-run-device-code">
      {/* Visual rendering: hidden from assistive tech so it isn't announced
          twice alongside the spelled-out version below. */}
      <p className="first-run-device-code__code" aria-hidden="true">
        {code}
      </p>
      {/* What a screen reader actually announces: discrete characters, with
          "-" replaced by the word "dash" rather than left for the screen
          reader to guess at. */}
      <p className="first-run-visually-hidden">Verification code: {spellOutCode(code)}</p>
      <button type="button" className="first-run-button" onClick={() => void handleCopy()}>
        Copy code
      </button>
      {/* Polite: confirms the copy happened without interrupting anything. */}
      <p className="first-run-visually-hidden" aria-live="polite">
        {copied ? 'Code copied to clipboard.' : ''}
      </p>
    </div>
  )
}
