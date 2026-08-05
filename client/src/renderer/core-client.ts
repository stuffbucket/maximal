// The renderer's ONE interface to maximal-core's control plane.
//
// It talks to the injected control-plane origin *directly* over HTTP + SSE — no
// Electron IPC for core data (ADR-0023, stuffbucket/maximal). Client code depends
// on this module, not the wire. Interim: it wraps maximal-core's current REST
// `/control/*` + SSE (`/control/events`) surface; when core ships the JSON-RPC
// control plane, only this file's internals change.
//
// AuthStatus mirrors maximal-core's ADR-0006 discriminated union (published as
// `@stuffbucket/maximal-core/settings-types`); kept as a local type here to keep
// the renderer bundle free of the engine package.

export type AuthStatus =
  | { state: 'unauthenticated' }
  | { state: 'device_code_issued'; user_code: string; verification_uri: string; expires_at?: string }
  | { state: 'polling'; user_code: string; verification_uri: string; expires_at?: string }
  | { state: 'authenticated'; account_login: string; account_host?: string }
  | { state: 'error'; error: string; remediation_url?: string }

export interface CoreClient {
  authStatus(): Promise<AuthStatus>
  authStart(): Promise<AuthStatus>
  signOut(): Promise<void>
  /** Subscribe to control-plane events (SSE). Returns an unsubscribe fn. */
  subscribe(onEvent: () => void): () => void
}

export function createCoreClient(origin: string): CoreClient {
  async function get<T>(path: string): Promise<T> {
    const res = await fetch(`${origin}${path}`)
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
    return (await res.json()) as T
  }

  async function post<T>(path: string): Promise<T> {
    // `text/plain` keeps this a CORS "simple request" (no preflight); the main
    // process's shim strips Origin + adds ACAO so a loopback call from the
    // renderer's foreign origin is accepted. maximal-core parses the empty body.
    const res = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
    })
    if (!res.ok) throw new Error(`POST ${path} → ${res.status}`)
    const text = await res.text()
    return (text ? JSON.parse(text) : {}) as T
  }

  return {
    authStatus: () => get<AuthStatus>('/control/auth'),
    authStart: () => post<AuthStatus>('/control/auth/start'),
    signOut: async () => {
      await post('/control/auth/sign-out')
    },
    subscribe(onEvent) {
      const es = new EventSource(`${origin}/control/events`)
      // Any control-plane activity (auth completing, account change, boot state)
      // prompts the renderer to re-read state — decoupled from the exact event
      // names, with a slow poll in the renderer as a safety net.
      const fire = () => onEvent()
      es.addEventListener('message', fire)
      // maximal-core's ControlHub sends named SSE frames (`snapshot` then topic
      // deltas). We react to any of them; the renderer's poll fallback covers a
      // topic name we don't list here.
      for (const topic of ['snapshot', 'auth.changed', 'accounts.changed', 'boot.state', 'clients.changed']) {
        es.addEventListener(topic, fire)
      }
      es.addEventListener('error', () => {
        // EventSource auto-reconnects; nothing to do. A dropped stream is covered
        // by the renderer's poll fallback + snapshot-on-reconnect.
      })
      return () => es.close()
    },
  }
}
