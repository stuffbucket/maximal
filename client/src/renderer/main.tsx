import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

interface AuthStatus {
  state: string
  user_code?: string
  verification_uri?: string
}
interface MaximalApi {
  coreStatus: () => Promise<{ baseUrl: string }>
  authStatus: () => Promise<AuthStatus>
  authStart: () => Promise<AuthStatus>
  openExternal: (url: string) => Promise<void>
}
declare global {
  interface Window {
    maximal: MaximalApi
  }
}

function App() {
  const [baseUrl, setBaseUrl] = useState('')
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  async function refresh() {
    const s = await window.maximal.authStatus()
    setStatus(s)
    if (s.state === 'authenticated' && pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  useEffect(() => {
    void window.maximal.coreStatus().then((s) => setBaseUrl(s.baseUrl))
    void refresh()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  async function signIn() {
    setBusy(true)
    try {
      const s = await window.maximal.authStart()
      setStatus(s)
      if (s.verification_uri) void window.maximal.openExternal(s.verification_uri)
      if (!pollRef.current) pollRef.current = setInterval(() => void refresh(), 2500)
    } finally {
      setBusy(false)
    }
  }

  const authed = status?.state === 'authenticated'
  const inFlow = status?.state === 'device_code_issued' || status?.state === 'polling'

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 32, lineHeight: 1.5 }}>
      <h1 style={{ margin: '0 0 4px' }}>Maximal</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        Engine: <code>{baseUrl || '…'}</code> — isolated from any proxy on :4141
      </p>
      <hr style={{ border: 0, borderTop: '1px solid #eee', margin: '16px 0' }} />
      <p>
        Status: <strong>{status?.state ?? 'loading…'}</strong>
      </p>
      {inFlow ? (
        <div style={{ background: '#f6f8fa', padding: 16, borderRadius: 8 }}>
          <p style={{ margin: '0 0 8px' }}>Enter this code on the GitHub page (opened for you):</p>
          <p style={{ fontSize: 28, fontWeight: 700, letterSpacing: 2, margin: 0 }}>
            {status?.user_code}
          </p>
          <p style={{ margin: '8px 0 0' }}>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault()
                if (status?.verification_uri) void window.maximal.openExternal(status.verification_uri)
              }}
            >
              {status?.verification_uri}
            </a>
          </p>
        </div>
      ) : null}
      {authed ? (
        <p style={{ color: '#137333', fontWeight: 600 }}>✓ Signed in</p>
      ) : (
        <button
          onClick={() => void signIn()}
          disabled={busy || !baseUrl}
          style={{ padding: '10px 18px', fontSize: 15, cursor: 'pointer' }}
        >
          {busy ? 'Starting…' : 'Sign in with GitHub'}
        </button>
      )}
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>)
