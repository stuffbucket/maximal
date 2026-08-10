import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import { displayAccountLogin } from '../shared/account-login'
import type { AuthStatus, SettingsCapabilities } from './capabilities'
import { DeviceCodePanel } from './DeviceCodePanel'
import { describeError, formatTimestamp } from './format'

// The Account section: who's signed in, sign in via GitHub's device flow,
// sign out. Written entirely against `SettingsCapabilities` — see
// capabilities.ts for why no component here imports `ControlClient` or
// touches `window.maximal` directly.

/** How often to re-read status while nothing is pushing changes. Covers the
 *  one transition the server doesn't proactively announce: a device code
 *  simply running out the clock (see capabilities.ts's `account.status` doc
 *  comment) — the next read is what collapses it, and this is what causes
 *  that next read to happen even if no one is pushing. */
const POLL_MS = 3000

interface AccountSectionProps {
  capabilities: SettingsCapabilities
}

export function AccountSection({ capabilities }: AccountSectionProps): ReactElement {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(busy)
  busyRef.current = busy

  // One effect owns the whole read lifetime: the first read, every later
  // push, the poll fallback, and teardown. Mirrors the pattern in
  // workspace/Workspace.tsx's snapshot effect.
  useEffect(() => {
    let settled = false

    const refresh = async () => {
      // A refresh racing an in-flight action (sign-in/out, cancel) would
      // render a status the action is about to supersede anyway; skip it
      // rather than flicker.
      if (busyRef.current) return
      try {
        const next = await capabilities.account.status()
        if (!settled) {
          setStatus(next)
          // A successful read supersedes any earlier transient failure — the
          // control plane has spoken again since, which is a more current
          // signal than a stale error from a previous poll. Without this, one
          // failed poll (e.g. mid core-restart) pins an assertive alert on
          // screen forever even after every later poll succeeds.
          setError(null)
        }
      } catch (cause) {
        if (!settled) setError(describeError(cause))
      }
    }

    void refresh()
    const unsubscribe = capabilities.subscribe(() => void refresh())
    const poll = setInterval(() => void refresh(), POLL_MS)

    return () => {
      settled = true
      unsubscribe()
      clearInterval(poll)
    }
  }, [capabilities])

  const runAction = useCallback(
    async (action: () => Promise<AuthStatus | void>) => {
      setBusy(true)
      setError(null)
      try {
        const next = await action()
        if (next) setStatus(next)
      } catch (cause) {
        setError(describeError(cause))
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  const handleStart = useCallback(() => void runAction(() => capabilities.account.start()), [capabilities, runAction])
  const handleCancel = useCallback(() => void runAction(() => capabilities.account.cancel()), [capabilities, runAction])
  const handleSignOut = useCallback(
    () =>
      void runAction(async () => {
        await capabilities.account.signOut()
        return capabilities.account.status()
      }),
    [capabilities, runAction],
  )
  const handleOpenVerification = useCallback(
    (uri: string) => {
      void capabilities.openExternal(uri)
    },
    [capabilities],
  )

  return (
    <section className="settings-section" aria-labelledby="settings-account-heading">
      <h2 id="settings-account-heading" className="settings-section__heading">
        Account
      </h2>

      {/* Assertive: a failed action needs to interrupt, not queue quietly
          behind whatever the user is doing next. */}
      {error ? (
        <p className="settings-note settings-note--error" role="alert" aria-live="assertive">
          {error}
        </p>
      ) : null}

      {status === null ? (
        <p className="settings-note" aria-live="polite">
          Loading account status…
        </p>
      ) : status.state === 'unauthenticated' ? (
        <div className="settings-field">
          <p className="settings-note">Not signed in.</p>
          {status.last_upstream_rejection ? (
            <p className="settings-note settings-note--warning">{status.last_upstream_rejection.message}</p>
          ) : null}
          <button type="button" className="settings-button settings-button--primary" onClick={handleStart} disabled={busy}>
            {busy ? 'Starting…' : 'Sign in with GitHub'}
          </button>
        </div>
      ) : status.state === 'device_code_issued' || status.state === 'polling' ? (
        <DeviceCodePanel
          status={status}
          busy={busy}
          onOpenVerification={() => handleOpenVerification(status.verification_uri)}
          onCancel={handleCancel}
          onRequestNewCode={handleStart}
        />
      ) : status.state === 'authenticated' ? (
        <div className="settings-field">
          <dl className="settings-details">
            <div className="settings-details__row">
              <dt>Signed in as</dt>
              <dd>{displayAccountLogin(status.account_login)}</dd>
            </div>
            {status.account_type ? (
              <div className="settings-details__row">
                <dt>Plan</dt>
                <dd>{status.account_type}</dd>
              </div>
            ) : null}
            {status.connected_since ? (
              <div className="settings-details__row">
                <dt>Connected since</dt>
                <dd>{formatTimestamp(status.connected_since)}</dd>
              </div>
            ) : null}
          </dl>
          {status.last_upstream_rejection ? (
            <p className="settings-note settings-note--warning">{status.last_upstream_rejection.message}</p>
          ) : null}
          <button type="button" className="settings-button" onClick={handleSignOut} disabled={busy}>
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      ) : (
        // status.state === 'error'
        <div className="settings-field">
          <p className="settings-note settings-note--error" role="alert" aria-live="assertive">
            {status.error}
            {status.remediation_url ? (
              <>
                {' '}
                <button type="button" className="settings-link-button" onClick={() => handleOpenVerification(status.remediation_url ?? '')}>
                  Learn more
                </button>
              </>
            ) : null}
          </p>
          <button type="button" className="settings-button settings-button--primary" onClick={handleStart} disabled={busy}>
            {busy ? 'Starting…' : 'Try again'}
          </button>
        </div>
      )}
    </section>
  )
}
