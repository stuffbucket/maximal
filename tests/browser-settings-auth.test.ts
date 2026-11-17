import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  browserApiKey,
  browserAuthRequired,
  clearBrowserApiKey,
  isApiKeyChallenge,
  isNativeShell,
  onBrowserAuthRequired,
  openBrowserAuth,
  requireBrowserAuth,
  saveBrowserApiKey,
} from "../shell/src/proxy/browser-auth"
import {
  createEventStreamParser,
  subscribeBrowserEvents,
} from "../shell/src/proxy/browser-events"

/**
 * Settings in a plain browser against a headless Maximal that requires API
 * keys (#672): a tab-scoped key in sessionStorage, sent only in headers;
 * Maximal's own key challenge told apart from 401s forwarded from GitHub;
 * the native shell's credentials untouched.
 */

// client.ts and problems.ts are webview (DOM) code, which the root program's
// server-side types can't check, so they load untyped and are described here
// by the slice this file uses. (browser-auth.ts and browser-events.ts are
// DOM-free and imported normally.)
interface Failure {
  ok: false
  status: number
  error: string
  authRequired?: boolean
}
type Result = { ok: true; data: unknown } | Failure
interface ClientSlice {
  apiCall: (
    endpoint: { kind: string; method: string; path: string; body?: unknown },
    options?: { apiKey?: string },
  ) => Promise<Result>
  fetchBudgetCsv: (query: string) => Promise<Result>
  subscribeAuthEvents: (handlers: {
    onAuth: (status: unknown) => void
    onOpen?: () => void
  }) => Promise<{ close: () => void }>
}
interface ProblemsSlice {
  describeProblem: (
    failure: Failure,
    context: { subject: string; upstream?: boolean },
  ) => { title: string; remedy: string }
}
const SHELL_SRC = "../shell/src"
const { apiCall, fetchBudgetCsv, subscribeAuthEvents } = (await import(
  `${SHELL_SRC}/proxy/client`
)) as ClientSlice
const { describeProblem } = (await import(
  `${SHELL_SRC}/ui/problems`
)) as ProblemsSlice

const CHALLENGE = { "www-authenticate": 'Bearer realm="copilot-api"' }
const STORAGE_KEY = "maximal.browserApiKey"

const saved = {
  sessionStorage: Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"),
  localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
  eventSource: Object.getOwnPropertyDescriptor(globalThis, "EventSource"),
  window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  fetch: globalThis.fetch,
}
const session = new Map<string, string>()
const local = new Map<string, string>()
const notifications: Array<string> = []
const cleanups: Array<() => void> = []

interface FetchCall {
  url: string
  method: string
  headers: Headers
}
const calls: Array<FetchCall> = []

function storage(map: Map<string, string>): Storage {
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size
    },
  }
}

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, value })
}

function restoreGlobal(
  name: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor)
  else Reflect.deleteProperty(globalThis, name)
}

/** Answer every fetch with `respond`, recording what was asked. */
function stubFetch(respond: (call: FetchCall) => Response): void {
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const call = {
        url: input instanceof Request ? input.url : input.toString(),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
      }
      calls.push(call)
      return Promise.resolve(respond(call))
    },
    { preconnect: saved.fetch.preconnect },
  )
}

const challenged = (): Response =>
  Response.json(
    { error: { message: "Unauthorized", type: "authentication_error" } },
    { status: 401, headers: CHALLENGE },
  )

function enterNativeShell(shellKey: string): void {
  const internals = {
    invoke: (command: string) =>
      Promise.resolve(command === "get_shell_api_key" ? shellKey : null),
  }
  defineGlobal("__TAURI_INTERNALS__", internals)
  // @tauri-apps/api's invoke() reads it from `window`.
  defineGlobal("window", globalThis)
}

beforeEach(() => {
  session.clear()
  local.clear()
  calls.length = 0
  notifications.length = 0
  defineGlobal("sessionStorage", storage(session))
  defineGlobal("localStorage", storage(local))
  cleanups.push(onBrowserAuthRequired(() => notifications.push("required")))
  // Clears the module's "required" flag left by an earlier test.
  saveBrowserApiKey("reset")
  clearBrowserApiKey()
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  globalThis.fetch = saved.fetch
  Reflect.deleteProperty(globalThis, "__TAURI_INTERNALS__")
  restoreGlobal("window", saved.window)
  restoreGlobal("sessionStorage", saved.sessionStorage)
  restoreGlobal("localStorage", saved.localStorage)
  restoreGlobal("EventSource", saved.eventSource)
})

describe("browser credentials", () => {
  test("only Maximal's key middleware challenge asks for browser access", () => {
    expect(isApiKeyChallenge(new Response(null, { status: 401 }))).toBe(false)
    expect(
      isApiKeyChallenge(
        new Response(null, {
          status: 401,
          headers: { "www-authenticate": 'Bearer realm="github"' },
        }),
      ),
    ).toBe(false)
    expect(
      isApiKeyChallenge(
        new Response(null, { status: 403, headers: CHALLENGE }),
      ),
    ).toBe(false)
    expect(
      isApiKeyChallenge(
        new Response(null, { status: 401, headers: CHALLENGE }),
      ),
    ).toBe(true)
  })

  test("the key is trimmed, kept only in session storage, and cleared", () => {
    expect(browserApiKey()).toBeUndefined()
    saveBrowserApiKey("  sample-key  ")
    expect(browserApiKey()).toBe("sample-key")
    expect(session.get(STORAGE_KEY)).toBe("sample-key")
    expect(local.size).toBe(0)
    clearBrowserApiKey()
    expect(browserApiKey()).toBeUndefined()
  })

  test("a refused key is forgotten and access is asked for once", () => {
    saveBrowserApiKey("old-key")
    requireBrowserAuth("old-key")
    requireBrowserAuth(undefined)
    expect(browserApiKey()).toBeUndefined()
    expect(browserAuthRequired()).toBe(true)
    expect(notifications).toEqual(["required"])
  })

  test("a late 401 for an old key cannot discard a newer one", () => {
    saveBrowserApiKey("new-key")
    requireBrowserAuth("old-key")
    expect(browserApiKey()).toBe("new-key")
    expect(browserAuthRequired()).toBe(false)
    expect(notifications).toEqual([])
  })

  test("the native shell ignores browser storage and never asks for access", () => {
    saveBrowserApiKey("browser-key")
    enterNativeShell("shell-key")
    expect(isNativeShell()).toBe(true)
    expect(browserApiKey()).toBeUndefined()
    requireBrowserAuth(undefined)
    openBrowserAuth()
    expect(browserAuthRequired()).toBe(false)
    expect(notifications).toEqual([])
  })

  test("disabled storage reads as no key, and saving says it failed", () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("denied", "SecurityError")
      },
    })
    expect(browserApiKey()).toBeUndefined()
    expect(() => saveBrowserApiKey("key")).toThrow("denied")
    expect(() => clearBrowserApiKey()).not.toThrow()
  })
})

describe("event-stream parser", () => {
  test("dispatches whole events across arbitrary chunk boundaries", () => {
    const got: Array<string> = []
    const feed = createEventStreamParser((event, data) =>
      got.push(`${event}|${data}`),
    )
    const stream =
      ': keep-alive\r\nevent: auth.changed\r\ndata: {"a":1}\r\n\r\n'
      + "id: 7\nretry: 100\ndata: line one\ndata:line two\n\n"
      + "event: lonely\n\n"
      + "event: plugins.changed\rdata: x\r\r\n"
    for (const ch of stream) feed(ch)
    expect(got).toEqual([
      'auth.changed|{"a":1}',
      "message|line one\nline two",
      "plugins.changed|x",
    ])
  })

  test("a CR at the end of a chunk waits for a possible LF", () => {
    const got: Array<string> = []
    const feed = createEventStreamParser((event, data) =>
      got.push(`${event}|${data}`),
    )
    feed("data: a\r")
    feed("\ndata: b\r")
    feed("\n\r")
    feed("\n")
    expect(got).toEqual(["message|a\nb"])
  })
})

describe("browser live events", () => {
  test("sends the key in a header, never the URL, and stops when closed", async () => {
    saveBrowserApiKey("event-key")
    const received = Promise.withResolvers<string>()
    stubFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'event: plugins.changed\ndata: {"ready":true}\n\n',
                ),
              )
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    )
    const subscription = subscribeBrowserEvents({
      onEvent: (event, data) => received.resolve(`${event}:${data}`),
    })
    cleanups.push(() => subscription.close())
    expect(await received.promise).toBe('plugins.changed:{"ready":true}')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("/settings/api/events")
    expect(calls[0].headers.get("x-api-key")).toBe("event-key")
    subscription.close()
    await Bun.sleep(10)
    expect(calls).toHaveLength(1)
  })

  test("Maximal's challenge stops reconnecting and clears a revoked key", async () => {
    saveBrowserApiKey("revoked-key")
    const failed = Promise.withResolvers<undefined>()
    stubFetch(challenged)
    const subscription = subscribeBrowserEvents({
      onEvent: () => {},
      onError: () => failed.resolve(undefined),
    })
    cleanups.push(() => subscription.close())
    await failed.promise
    expect(browserApiKey()).toBeUndefined()
    expect(browserAuthRequired()).toBe(true)
    expect(notifications).toEqual(["required"])
    expect(calls).toHaveLength(1)
  })

  test("a 401 without Maximal's challenge keeps the key", async () => {
    saveBrowserApiKey("good-key")
    const failed = Promise.withResolvers<undefined>()
    stubFetch(() =>
      Response.json({ error: "not_authenticated" }, { status: 401 }),
    )
    const subscription = subscribeBrowserEvents({
      onEvent: () => {},
      onError: () => failed.resolve(undefined),
    })
    cleanups.push(() => subscription.close())
    await failed.promise
    subscription.close()
    expect(browserApiKey()).toBe("good-key")
    expect(browserAuthRequired()).toBe(false)
  })

  test("Settings' auth stream uses fetch with a header in a browser", async () => {
    saveBrowserApiKey("browser-key")
    const opened = Promise.withResolvers<undefined>()
    defineGlobal("EventSource", function refuseEventSource(): never {
      throw new Error("EventSource must not carry a browser key")
    })
    stubFetch(
      () =>
        new Response(new ReadableStream(), {
          headers: { "content-type": "text/event-stream" },
        }),
    )
    const subscription = await subscribeAuthEvents({
      onAuth: () => {},
      onOpen: () => opened.resolve(undefined),
    })
    cleanups.push(() => subscription.close())
    await opened.promise
    expect(calls[0].url).toBe("/settings/api/events")
    expect(calls[0].headers.get("x-api-key")).toBe("browser-key")
  })

  test("the native shell keeps its EventSource and per-launch key", async () => {
    saveBrowserApiKey("browser-key")
    enterNativeShell("shell-key")
    const urls: Array<string> = []
    defineGlobal(
      "EventSource",
      class {
        constructor(url: string) {
          urls.push(url)
        }
        addEventListener(): void {}
        close(): void {}
      },
    )
    stubFetch(() => {
      throw new Error("the native stream must not use fetch")
    })
    const subscription = await subscribeAuthEvents({ onAuth: () => {} })
    subscription.close()
    expect(urls).toEqual(["/settings/api/events?key=shell-key"])
    expect(calls).toHaveLength(0)
  })
})

describe("browser Settings API calls", () => {
  const status = {
    kind: "auth-status",
    method: "GET",
    path: "/settings/api/auth/github/status",
  } as const

  test("send the tab's key in a header", async () => {
    saveBrowserApiKey("browser-key")
    stubFetch(() => Response.json({ state: "unauthenticated" }))
    const result = await apiCall(status)
    expect(result.ok).toBe(true)
    expect(calls[0].url).toBe("/settings/api/auth/github/status")
    expect(calls[0].headers.get("x-api-key")).toBe("browser-key")
  })

  test("Maximal's challenge is reported, clears the key and asks once; the write is not resent", async () => {
    saveBrowserApiKey("revoked-key")
    stubFetch(challenged)
    const result = await apiCall({
      kind: "plugins-tool-permissions",
      method: "PUT",
      path: "/settings/api/plugins/workiq/tool-permissions",
      body: { permissions: {} },
    })
    expect(result).toMatchObject({ ok: false, status: 401, authRequired: true })
    expect(browserApiKey()).toBeUndefined()
    expect(notifications).toEqual(["required"])
    saveBrowserApiKey("new-key")
    await Bun.sleep(10)
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1)
  })

  test("an upstream GitHub 401 keeps the browser's key", async () => {
    saveBrowserApiKey("browser-key")
    stubFetch(() =>
      Response.json({ error: "not_authenticated" }, { status: 401 }),
    )
    const result = await apiCall({
      kind: "models-refresh",
      method: "POST",
      path: "/settings/api/models/refresh",
    })
    expect(result.ok).toBe(false)
    expect(result.ok ? undefined : result.authRequired).toBeUndefined()
    expect(browserApiKey()).toBe("browser-key")
    expect(notifications).toEqual([])
  })

  test("a key being tested by the dialog doesn't disturb stored state when refused", async () => {
    saveBrowserApiKey("current-key")
    stubFetch(challenged)
    const result = await apiCall(status, { apiKey: "typo" })
    expect(result).toMatchObject({ ok: false, authRequired: true })
    expect(calls[0].headers.get("x-api-key")).toBe("typo")
    expect(browserApiKey()).toBe("current-key")
    expect(browserAuthRequired()).toBe(false)
    expect(notifications).toEqual([])
  })

  test("the activity CSV download is authenticated the same way", async () => {
    saveBrowserApiKey("revoked-key")
    stubFetch(challenged)
    const result = await fetchBudgetCsv("range=7d")
    expect(calls[0].headers.get("x-api-key")).toBe("revoked-key")
    expect(result).toMatchObject({ ok: false, authRequired: true })
    expect(browserAuthRequired()).toBe(true)
  })
})

const unauthorized = (authRequired?: boolean): Failure => ({
  ok: false,
  status: 401,
  error: "Unauthorized",
  ...(authRequired ? { authRequired } : {}),
})

describe("describeProblem", () => {
  const failure = unauthorized

  test("missing browser access offers Connect, even on an upstream call", () => {
    for (const upstream of [false, true]) {
      const problem = describeProblem(failure(true), {
        subject: "the models",
        upstream,
      })
      expect(problem.remedy).toBe("connect-browser")
      expect(problem.title).toBe("This browser isn't connected to Maximal")
    }
  })

  test("an upstream 401 without the challenge is still a GitHub sign-in", () => {
    const problem = describeProblem(failure(), {
      subject: "the models",
      upstream: true,
    })
    expect(problem.remedy).toBe("sign-in")
  })

  test("the native shell's key mismatch still suggests a restart", () => {
    enterNativeShell("shell-key")
    const problem = describeProblem(failure(true), { subject: "your apps" })
    expect(problem.remedy).toBe("restart")
  })
})
