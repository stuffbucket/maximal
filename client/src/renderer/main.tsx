import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { createCoreClient, type AuthStatus, type CoreClient } from './core-client'

declare global {
  interface Window {
    maximal: {
      getCoreOrigin: () => Promise<string>
      getProxyUrl: () => Promise<string>
      openExternal: (url: string) => Promise<void>
    }
  }
}

function App() {
  const [proxy, setProxy] = useState('')
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clientRef = useRef<CoreClient | null>(null)

  useEffect(() => {
    let unsub = () => {}
    let poll: ReturnType<typeof setInterval> | null = null
    void (async () => {
      const [origin, proxyUrl] = await Promise.all([
        window.maximal.getCoreOrigin(),
        window.maximal.getProxyUrl(),
      ])
      setProxy(proxyUrl)
      const client = createCoreClient(origin)
      clientRef.current = client
      const refresh = async () => {
        try {
          setStatus(await client.authStatus())
        } catch {
          // transient — the poll/SSE will retry
        }
      }
      await refresh()
      // Fast path: react to control-plane events (sign-in completing, etc.).
      // Fallback: a slow poll covers any missed/renamed event.
      unsub = client.subscribe(() => void refresh())
      poll = setInterval(() => void refresh(), 3000)
    })()
    return () => {
      unsub()
      if (poll) clearInterval(poll)
    }
  }, [])

  async function signIn() {
    const client = clientRef.current
    if (!client) return
    setBusy(true)
    setError(null)
    try {
      const s = await client.authStart()
      setStatus(s)
      if ('verification_uri' in s && s.verification_uri) {
        void window.maximal.openExternal(s.verification_uri)
      }
    } catch (err) {
      setError(`Couldn't start sign-in: ${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    const client = clientRef.current
    if (!client) return
    await client.signOut()
    setStatus(await client.authStatus())
  }

  const authed = status?.state === 'authenticated'
  const inFlow = status?.state === 'device_code_issued' || status?.state === 'polling'
  const code = status && 'user_code' in status ? status.user_code : undefined
  const verify = status && 'verification_uri' in status ? status.verification_uri : undefined

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 32, lineHeight: 1.5 }}>
      <h1 style={{ margin: '0 0 4px' }}>Maximal</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        Proxy: <code>{proxy ? `${proxy}/v1` : '…'}</code> — point OpenAI-compatible clients here
      </p>
      <hr style={{ border: 0, borderTop: '1px solid #eee', margin: '16px 0' }} />
      <p>
        Status: <strong>{status?.state ?? 'loading…'}</strong>
      </p>
      {error ? <p style={{ color: '#c5221f' }}>{error}</p> : null}
      {inFlow ? (
        <div style={{ background: '#f6f8fa', padding: 16, borderRadius: 8 }}>
          <p style={{ margin: '0 0 8px' }}>Enter this code on the GitHub page (opened for you):</p>
          <p style={{ fontSize: 28, fontWeight: 700, letterSpacing: 2, margin: 0 }}>{code}</p>
          {verify ? (
            <p style={{ margin: '8px 0 0' }}>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault()
                  void window.maximal.openExternal(verify)
                }}
              >
                {verify}
              </a>
            </p>
          ) : null}
        </div>
      ) : null}
      {authed ? (
        <p>
          <span style={{ color: '#137333', fontWeight: 600 }}>Signed in</span>
          {' — '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault()
              void signOut()
            }}
          >
            sign out
          </a>
        </p>
      ) : (
        <button
          onClick={() => void signIn()}
          disabled={busy || !clientRef.current}
          style={{ padding: '10px 18px', fontSize: 15, cursor: 'pointer' }}
        >
          {busy ? 'Starting…' : 'Sign in with GitHub'}
        </button>
      )}
    </div>
  )
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
