/**
 * Renderer. Talks to the engine only through the preload bridge.
 *
 * `server/discover` first, deliberately: it is how a client learns the protocol
 * version and the callable method set rather than assuming either, and it needs
 * no handshake (maximal-core#8).
 */
interface Bridge {
  call<T>(method: string, params?: unknown): Promise<{ ok: boolean; result?: T; error?: string }>
  boot(): Promise<{ port: number | null; pid: number | null; lines: string[] }>
}
declare global {
  interface Window {
    maximal: Bridge
  }
}

const set = (id: string, text: string): void => {
  const el = document.getElementById(id)
  if (el) el.textContent = text
}

async function main(): Promise<void> {
  const boot = await window.maximal.boot()
  set("engine", boot.port ? `127.0.0.1:${boot.port} (pid ${boot.pid})` : "not running")
  set("boot", boot.lines.join("\n"))

  const discovered = await window.maximal.call<{
    protocolVersion: string
    capabilities: { methods: string[] }
  }>("server/discover")
  if (!discovered.ok || !discovered.result) {
    set("protocol", `unavailable — ${discovered.error ?? "unknown"}`)
    return
  }
  const label = `v${discovered.result.protocolVersion} · ${discovered.result.capabilities.methods.length} methods`
  set("protocol", label)

  const auth = await window.maximal.call<{ state: string }>("auth/status")
  const state = auth.ok && auth.result ? auth.result.state : (auth.error ?? "error")
  set("auth", state)
}

void main()

export {}
