import { createServer, type Server } from "node:http"

/** A one-shot OAuth redirect listener on 127.0.0.1 (RFC 8252 loopback redirect). */
export interface LoopbackRedirect {
  /** `http://127.0.0.1:<port><path>` — what the authorization request names. */
  readonly redirectUri: string
  /** Query parameters of the first request to the redirect path. */
  readonly result: Promise<URLSearchParams>
  close(): Promise<void>
}

export interface LoopbackOptions {
  /** `0` (default) picks a free port. */
  port?: number
  path?: string
  /** HTML shown in the browser; `ok` when the redirect carried a code. */
  page(ok: boolean): string
}

/** Start the listener; `result` rejects when `signal` aborts. */
export async function startLoopbackRedirect(
  options: LoopbackOptions,
  signal: AbortSignal,
): Promise<LoopbackRedirect> {
  const path = options.path ?? "/callback"
  let resolve!: (params: URLSearchParams) => void
  let reject!: (error: unknown) => void
  const result = new Promise<URLSearchParams>((res, rej) => {
    resolve = res
    reject = rej
  })
  result.catch(() => {})
  let settled = false
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (request.method !== "GET" || url.pathname !== path || settled) {
      response.writeHead(404, { "content-type": "text/plain" }).end()
      return
    }
    settled = true
    const ok = url.searchParams.has("code")
    response
      .writeHead(ok ? 200 : 400, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      })
      .end(options.page(ok))
    resolve(url.searchParams)
  })
  await new Promise<void>((listening, failed) => {
    server.once("error", failed)
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", failed)
      listening()
    })
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  let closed: Promise<void> | undefined
  const close = () => {
    closed ??= new Promise<void>((done) => {
      server.close(() => done())
      server.closeAllConnections()
    })
    return closed
  }
  const onAbort = () => {
    reject(signal.reason)
    void close()
  }
  if (signal.aborted) onAbort()
  else signal.addEventListener("abort", onAbort, { once: true })
  const detach = () => signal.removeEventListener("abort", onAbort)
  result.then(detach, detach)
  return {
    redirectUri: `http://127.0.0.1:${port}${path}`,
    result,
    close,
  }
}
