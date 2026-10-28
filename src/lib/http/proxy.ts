import consola from "consola"
import { getProxyForUrl } from "proxy-from-env"
import { Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici"

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"]

/**
 * Add the loopback hosts to NO_PROXY (and no_proxy). Bun's fetch reads
 * HTTP_PROXY itself and sends even a 127.0.0.1 request through it, and a
 * proxy can't reach this machine's loopback, where the MCP broker listens.
 */
export function keepLoopbackOffProxy(
  env: Record<string, string | undefined> = process.env,
): void {
  const current = (env.NO_PROXY ?? env.no_proxy ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean)
  const missing = LOOPBACK_HOSTS.filter((host) => !current.includes(host))
  if (missing.length === 0) return
  const value = [...current, ...missing].join(",")
  env.NO_PROXY = value
  env.no_proxy = value
}

export function initProxyFromEnv(): void {
  if (typeof Bun !== "undefined") {
    keepLoopbackOffProxy()
    return
  }

  try {
    const direct = new Agent()
    const proxies = new Map<string, ProxyAgent>()

    // We only need a minimal dispatcher that implements `dispatch` at runtime.
    // Typing the object as `Dispatcher` forces TypeScript to require many
    // additional methods. Instead, keep a plain object and cast when passing
    // to `setGlobalDispatcher`.
    const dispatcher = {
      dispatch(
        options: Dispatcher.DispatchOptions,
        handler: Dispatcher.DispatchHandler,
      ) {
        try {
          const origin =
            typeof options.origin === "string" ?
              new URL(options.origin)
            : (options.origin as URL)
          const get = getProxyForUrl as unknown as (
            u: string,
          ) => string | undefined
          const raw = get(origin.toString())
          const proxyUrl = raw && raw.length > 0 ? raw : undefined
          if (!proxyUrl) {
            consola.debug(`HTTP proxy bypass: ${origin.hostname}`)
            return (direct as unknown as Dispatcher).dispatch(options, handler)
          }
          let agent = proxies.get(proxyUrl)
          if (!agent) {
            agent = new ProxyAgent(proxyUrl)
            proxies.set(proxyUrl, agent)
          }
          let label = proxyUrl
          try {
            const u = new URL(proxyUrl)
            label = `${u.protocol}//${u.host}`
          } catch {
            /* noop */
          }
          consola.debug(`HTTP proxy route: ${origin.hostname} via ${label}`)
          return agent.dispatch(options, handler)
        } catch {
          return (direct as unknown as Dispatcher).dispatch(options, handler)
        }
      },
      close() {
        return direct.close()
      },
      destroy() {
        return direct.destroy()
      },
    }

    setGlobalDispatcher(dispatcher as unknown as Dispatcher)
    consola.debug("HTTP proxy configured from environment (per-URL)")
  } catch (err) {
    consola.debug("Proxy setup skipped:", err)
  }
}
