import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import 'stuffbucket-electron/renderer/styles.css'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/shell-adapter.css'
import './styles/live-app.css'
import './styles/workspace-preview.css'

import { createCoreClient, type AuthStatus, type CoreClient } from './core-client'
import { WorkspacePreview } from './preview/WorkspacePreview'

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
      const nextStatus = await client.authStart()
      setStatus(nextStatus)
      if ('verification_uri' in nextStatus && nextStatus.verification_uri) {
        void window.maximal.openExternal(nextStatus.verification_uri)
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
    <main className="live-app" data-theme="light">
      <h1>Maximal</h1>
      <p className="live-app__proxy">
        Proxy: <code>{proxy ? `${proxy}/v1` : '…'}</code> — point OpenAI-compatible clients here
      </p>
      <hr />
      <p>
        Status: <strong>{status?.state ?? 'loading…'}</strong>
      </p>
      {error ? <p className="live-app__error">{error}</p> : null}
      {inFlow ? (
        <section className="live-app__device-code">
          <p>Enter this code on the GitHub page (opened for you):</p>
          <strong>{code}</strong>
          {verify ? (
            <p>
              <a
                href={verify}
                onClick={(event) => {
                  event.preventDefault()
                  void window.maximal.openExternal(verify)
                }}
              >
                {verify}
              </a>
            </p>
          ) : null}
        </section>
      ) : null}
      {authed ? (
        <p>
          <span className="live-app__success">Signed in</span>
          {' — '}
          <button type="button" className="live-app__text-action" onClick={() => void signOut()}>
            sign out
          </button>
        </p>
      ) : (
        <button type="button" className="live-app__button" onClick={() => void signIn()} disabled={busy || !clientRef.current}>
          {busy ? 'Starting…' : 'Sign in with GitHub'}
        </button>
      )}
    </main>
  )
}

const showWorkspacePreview = import.meta.env.DEV
  && new URLSearchParams(location.search).get('preview') === 'workspace'
const RendererRoot = showWorkspacePreview ? WorkspacePreview : App
const container = document.getElementById('root')

if (container) {
  createRoot(container).render(
    <StrictMode>
      <RendererRoot />
    </StrictMode>,
  )
}
