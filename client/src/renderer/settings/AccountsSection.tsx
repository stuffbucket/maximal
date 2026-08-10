import { useCallback, useEffect, useState, type ReactElement } from 'react'

import type { AccountsListResponse, SettingsCapabilities } from './capabilities'
import { addedViaLabel, describeError, formatTimestamp } from './format'

// The Accounts section: every account maximal-core knows about, and which
// one is active. Switching is the only mutation this section offers —
// removing an account is explicitly deferred (see capabilities.ts).

interface AccountsSectionProps {
  capabilities: SettingsCapabilities
}

export function AccountsSection({ capabilities }: AccountsSectionProps): ReactElement {
  const [list, setList] = useState<AccountsListResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [switchingKey, setSwitchingKey] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let settled = false

    const refresh = async () => {
      try {
        const next = await capabilities.accounts.list()
        if (!settled) {
          setList(next)
          setError(null)
        }
      } catch (cause) {
        if (!settled) setError(describeError(cause))
      }
    }

    void refresh()
    const unsubscribe = capabilities.subscribe(() => void refresh())

    return () => {
      settled = true
      unsubscribe()
    }
  }, [capabilities, reloadKey])

  const handleSwitch = useCallback(
    async (key: string) => {
      setSwitchingKey(key)
      setError(null)
      try {
        await capabilities.accounts.switchTo(key)
        setList(await capabilities.accounts.list())
      } catch (cause) {
        setError(describeError(cause))
      } finally {
        setSwitchingKey(null)
      }
    },
    [capabilities],
  )

  return (
    <section className="settings-section" aria-labelledby="settings-accounts-heading">
      <h2 id="settings-accounts-heading" className="settings-section__heading">
        Accounts
      </h2>

      {error ? (
        <p className="settings-note settings-note--error" role="alert" aria-live="assertive">
          {error}{' '}
          <button type="button" className="settings-link-button" onClick={() => setReloadKey((k) => k + 1)}>
            Try again
          </button>
        </p>
      ) : null}

      {list === null ? (
        <p className="settings-note" aria-live="polite">
          Loading accounts…
        </p>
      ) : list.accounts.length === 0 ? (
        <p className="settings-note">No accounts yet.</p>
      ) : (
        <ul className="settings-accounts-list">
          {list.accounts.map((account) => {
            const isActive = account.key === list.active_key
            const isSwitching = switchingKey === account.key
            return (
              <li key={account.key} className="settings-accounts-list__row">
                <div className="settings-accounts-list__identity">
                  <span className="settings-accounts-list__login">{account.login}</span>
                  <span className="settings-accounts-list__meta">
                    {account.host} · {addedViaLabel(account.added_via)} · added {formatTimestamp(account.obtained_at)}
                  </span>
                </div>
                {isActive ? (
                  <span className="settings-accounts-list__active-badge">Active</span>
                ) : (
                  <button
                    type="button"
                    className="settings-button"
                    onClick={() => void handleSwitch(account.key)}
                    disabled={switchingKey !== null}
                  >
                    {isSwitching ? 'Switching…' : 'Switch to this account'}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {/*
       * Removing an account (`accounts/remove`) is deliberately unavailable
       * to the renderer. Adding it would require a new explicit main/preload
       * capability plus confirmation UX; it cannot be reached through the
       * closed bridge's current allowlist.
       */}
    </section>
  )
}
