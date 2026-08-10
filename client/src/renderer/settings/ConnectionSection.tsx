import { useEffect, useState, type ReactElement } from 'react'

import type { SettingsCapabilities } from './capabilities'
import { describeError } from './format'

// The Connection section: the proxy URL external programs (the Anthropic
// SDK, OpenAI SDK, opencode, custom scripts — see .design-context.md's "Who
// maximal is for") should point at. Display + copy only; there is nothing to
// configure here today.

interface ConnectionSectionProps {
  capabilities: SettingsCapabilities
}

/** How long the "Copied" confirmation stays up before reverting to the plain
 *  "Copy" label. Not an animation — just text — so it needs no
 *  reduced-motion handling. */
const COPIED_RESET_MS = 2000

export function ConnectionSection({ capabilities }: ConnectionSectionProps): ReactElement {
  const [proxyUrl, setProxyUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let settled = false

    // One effect owns the whole read lifetime, mirroring AccountSection's
    // shape: the first read, every later push, and teardown. `proxyUrl()`
    // now tracks the sidecar's CURRENT proxy port rather than a value
    // captured once before core existed (review finding M1) — but that only
    // helps a mounted component if it asks again after a restart. `subscribe`
    // fires on every control-plane state change, including the explicit
    // invalidation main emits after installing a restart replacement, so it
    // doubles as the restart signal here even though this section has no
    // auth/account state of its own to refresh.
    const refresh = () => {
      capabilities.connection
        .proxyUrl()
        .then((url) => {
          if (!settled) setProxyUrl(url)
        })
        .catch((cause: unknown) => {
          if (!settled) setError(describeError(cause))
        })
    }

    refresh()
    const unsubscribe = capabilities.subscribe(refresh)
    return () => {
      settled = true
      unsubscribe()
    }
  }, [capabilities])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS)
    return () => clearTimeout(timer)
  }, [copied])

  const endpoint = proxyUrl ? `${proxyUrl}/v1` : null

  const handleCopy = () => {
    if (!endpoint) return
    void navigator.clipboard
      .writeText(endpoint)
      .then(() => setCopied(true))
      .catch(() => {
        // Clipboard access can fail (permissions, headless CI, etc.); the
        // endpoint is still selectable text in the field below, so this is
        // not a blocking failure — no error surfaced.
      })
  }

  return (
    <section className="settings-section" aria-labelledby="settings-connection-heading">
      <h2 id="settings-connection-heading" className="settings-section__heading">
        Connection
      </h2>
      <p className="settings-note">Point OpenAI-compatible clients at this address.</p>

      {error ? (
        <p className="settings-note settings-note--error" role="alert" aria-live="assertive">
          {error}
        </p>
      ) : endpoint === null ? (
        <p className="settings-note" aria-live="polite">
          Loading connection details…
        </p>
      ) : (
        <div className="settings-connection-row">
          <code className="settings-connection-row__value">{endpoint}</code>
          <button type="button" className="settings-button" onClick={handleCopy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          {/* Polite live region announces the confirmation without stealing
              focus from the button that just fired it. */}
          <span className="settings-visually-hidden" aria-live="polite">
            {copied ? 'Copied to clipboard' : ''}
          </span>
        </div>
      )}
    </section>
  )
}
