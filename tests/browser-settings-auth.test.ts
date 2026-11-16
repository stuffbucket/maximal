import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  browserApiKey,
  isApiKeyChallenge,
  browserAuthRequired,
  clearBrowserApiKey,
  requireBrowserAuth,
  onBrowserAuthRequired,
  saveBrowserApiKey,
} from "../shell/src/proxy/browser-auth"
import { subscribeBrowserEvents } from "../shell/src/proxy/browser-events"

const originalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "sessionStorage",
)
const originalTauri = Object.getOwnPropertyDescriptor(globalThis, "isTauri")
const originalFetch = globalThis.fetch
const values = new Map<string, string>()
const notifications: Array<string> = []
const subscriptions: Array<{ close: () => void }> = []

beforeEach(() => {
  values.clear()
  notifications.length = 0
  Object.defineProperty(globalThis, "isTauri", {
    configurable: true,
    value: false,
  })
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  })
  subscriptions.push({
    close: onBrowserAuthRequired(() => {
      notifications.push("maximal:browser-auth-required")
    }),
  })
  saveBrowserApiKey("reset-required-flag")
  clearBrowserApiKey()
})

afterEach(() => {
  for (const subscription of subscriptions.splice(0)) subscription.close()
  globalThis.fetch = originalFetch
  if (originalStorage)
    Object.defineProperty(globalThis, "sessionStorage", originalStorage)
  else Reflect.deleteProperty(globalThis, "sessionStorage")
  if (originalTauri) Object.defineProperty(globalThis, "isTauri", originalTauri)
  else Reflect.deleteProperty(globalThis, "isTauri")
})

describe("browser credentials", () => {
  test("only the key middleware challenge requires browser access", () => {
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
        new Response(null, {
          status: 401,
          headers: { "www-authenticate": 'Bearer realm="copilot-api"' },
        }),
      ),
    ).toBe(true)
  })
  test("tab-scoped storage trims the key and clearing removes it", () => {
    expect(browserApiKey()).toBeUndefined()
    saveBrowserApiKey("  sample-key  ")
    expect(browserApiKey()).toBe("sample-key")
    clearBrowserApiKey()
    expect(browserApiKey()).toBeUndefined()
  })

  test("a rejected credential is removed and requests access", () => {
    saveBrowserApiKey("old-key")
    requireBrowserAuth("old-key")
    requireBrowserAuth(undefined)
    expect(browserApiKey()).toBeUndefined()
    expect(browserAuthRequired()).toBe(true)
    expect(notifications).toEqual(["maximal:browser-auth-required"])
  })

  test("a delayed 401 cannot discard a newer credential", () => {
    saveBrowserApiKey("new-key")
    requireBrowserAuth("old-key")
    expect(browserApiKey()).toBe("new-key")
    expect(browserAuthRequired()).toBe(false)
    expect(notifications).toEqual([])
  })

  test("native shell ignores browser storage and browser access requests", () => {
    saveBrowserApiKey("browser-key")
    Object.defineProperty(globalThis, "isTauri", {
      configurable: true,
      value: true,
    })
    expect(browserApiKey()).toBeUndefined()
    requireBrowserAuth(undefined)
    expect(browserAuthRequired()).toBe(false)
    expect(notifications).toEqual([])
  })

  test("disabled storage is readable as no credential, but saving reports the failure", () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      get: () => {
        throw new Error("denied")
      },
    })
    expect(browserApiKey()).toBeUndefined()
    expect(() => saveBrowserApiKey("key")).toThrow("denied")
    expect(() => clearBrowserApiKey()).not.toThrow()
  })
})

describe("browser live events", () => {
  test("parses streamed events with a header credential and closes without reconnecting", async () => {
    saveBrowserApiKey("event-key")
    const received = Promise.withResolvers<string>()
    let calls = 0
    globalThis.fetch = Object.assign(
      (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls++
        expect(input).toBe("/settings/api/events")
        expect(new Headers(init?.headers).get("x-api-key")).toBe("event-key")
        return Promise.resolve(
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
      },
      { preconnect: originalFetch.preconnect },
    )
    const subscription = subscribeBrowserEvents({
      onEvent: (event, data) => received.resolve(`${event}:${data}`),
    })
    subscriptions.push(subscription)
    expect(await received.promise).toBe('plugins.changed:{"ready":true}')
    subscription.close()
    await Bun.sleep(10)
    expect(calls).toBe(1)
  })

  test("401 stops reconnecting and clears a revoked key", async () => {
    saveBrowserApiKey("revoked-key")
    const failed = Promise.withResolvers<undefined>()
    let calls = 0
    globalThis.fetch = Object.assign(
      () => {
        calls++
        return Promise.resolve(
          new Response(null, {
            status: 401,
            headers: { "www-authenticate": 'Bearer realm="copilot-api"' },
          }),
        )
      },
      { preconnect: originalFetch.preconnect },
    )
    subscriptions.push(
      subscribeBrowserEvents({
        onEvent: () => {},
        onError: () => failed.resolve(undefined),
      }),
    )
    await failed.promise
    expect(browserApiKey()).toBeUndefined()
    expect(browserAuthRequired()).toBe(true)
    expect(calls).toBe(1)
  })
})
