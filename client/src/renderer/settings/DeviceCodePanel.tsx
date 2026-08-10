import { useEffect, useState, type ReactElement } from 'react'

import { spellOutCode } from '../shared/device-code'
import { hasExpired, minutesRemaining } from './format'

// The device-code panel: the code, the verification link, and the two ways
// out (finish on GitHub, or cancel). Presentational + a small local timer for
// the expiry text — no data fetching. See AccountSection.tsx for the
// subscribe/poll loop that keeps `status` current, including the collapse
// back to unauthenticated/authenticated that the server performs once the
// code actually expires (capabilities.ts's `account.status` doc comment).

export interface DeviceCodeStatus {
  user_code: string
  verification_uri: string
  expires_at: string
}

interface DeviceCodePanelProps {
  status: DeviceCodeStatus
  onOpenVerification: () => void
  onCancel: () => void
  onRequestNewCode: () => void
  busy: boolean
}

/** Recomputed every 15s rather than every second — this is a coarse "how much
 *  time do I have left" cue, not a precision countdown, and a coarser tick
 *  respects `prefers-reduced-motion` users by not re-rendering constantly. */
const TICK_MS = 15_000

export function DeviceCodePanel({
  status,
  onOpenVerification,
  onCancel,
  onRequestNewCode,
  busy,
}: DeviceCodePanelProps): ReactElement {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const expired = hasExpired(status.expires_at, now)
  const minutesLeft = minutesRemaining(status.expires_at, now)

  return (
    <div className="settings-device-code">
      <p className="settings-device-code__instructions">
        Enter this code on GitHub to finish signing in:
      </p>
      {/* Visual rendering: hidden from assistive tech so it isn't announced
          twice alongside the spelled-out version below. `aria-label` on a
          role-less `<p>` is prohibited by ARIA-in-HTML and silently dropped
          by browsers/screen readers — the name must be exposed via a real
          text node instead (matches first-run/DeviceCode.tsx). */}
      <p className="settings-device-code__code" aria-hidden="true">
        {status.user_code}
      </p>
      {/* What a screen reader actually announces: discrete characters, with
          "-" replaced by the word "dash" — the same spelling first-run uses,
          via the shared `spellOutCode` helper, so the code reads identically
          in both surfaces. */}
      <p className="settings-visually-hidden">Verification code: {spellOutCode(status.user_code)}</p>
      <p className="settings-device-code__link-row">
        <button type="button" className="settings-link-button" onClick={onOpenVerification} disabled={busy}>
          Open {status.verification_uri}
        </button>
      </p>
      {/* Polite: this is progress narration, not a blocking error. */}
      <p className="settings-device-code__status" aria-live="polite">
        {expired
          ? 'This code has expired.'
          : `Waiting for you to finish on GitHub… code expires in ${String(minutesLeft)} minute${minutesLeft === 1 ? '' : 's'}.`}
      </p>
      <div className="settings-device-code__actions">
        {expired ? (
          <button type="button" className="settings-button settings-button--primary" onClick={onRequestNewCode} disabled={busy}>
            {busy ? 'Requesting…' : 'Get a new code'}
          </button>
        ) : null}
        <button type="button" className="settings-button" onClick={onCancel} disabled={busy}>
          Cancel sign-in
        </button>
      </div>
    </div>
  )
}
