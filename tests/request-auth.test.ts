import type { Context } from "hono"

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import {
  apiKeyAllowed,
  createAuthMiddleware,
  defaultGetRequestIp,
  extractRequestApiKey,
  getConfiguredApiKeys,
  isLoopbackAddress,
  normalizeApiKeys,
  requireGithubAuth,
} from "../src/lib/request-auth"
import { state } from "../src/lib/state"

function buildApp(opts: {
  apiKeys: Array<string>
  loopbackOnlyPaths?: Array<string>
  allowUnauthenticatedPrefixes?: Array<string>
  ip: string | null
  /** Defaults to true — pre-enforce-flag tests assume key gating is on. */
  enforce?: boolean
}) {
  const app = new Hono()
  app.use(
    "*",
    createAuthMiddleware({
      getApiKeys: () => opts.apiKeys,
      isEnforcing: () => opts.enforce !== false,
      allowUnauthenticatedPaths: ["/"],
      loopbackOnlyPaths: opts.loopbackOnlyPaths,
      allowUnauthenticatedPrefixes: opts.allowUnauthenticatedPrefixes,
      getRequestIp: () => opts.ip,
    }),
  )
  app.get("/usage", (c) => c.text("usage-ok"))
  app.get("/token-usage", (c) => c.text("token-usage-ok"))
  app.get("/token-usage/events", (c) => c.text("events-ok"))
  app.post("/v1/messages", (c) => c.text("messages-ok"))
  app.get("/settings", (c) => c.text("settings-ok"))
  app.get("/settings/assets/index.js", (c) => c.text("asset-ok"))
  app.get("/settings-not-this-one", (c) => c.text("not-prefix"))
  return app
}

describe("isLoopbackAddress", () => {
  test("accepts 127.0.0.1, ::1, ::ffff:127.0.0.1", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true)
    expect(isLoopbackAddress("::1")).toBe(true)
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true)
  })

  test("rejects everything else", () => {
    expect(isLoopbackAddress("192.168.1.5")).toBe(false)
    expect(isLoopbackAddress("10.0.0.1")).toBe(false)
    expect(isLoopbackAddress("::ffff:10.0.0.1")).toBe(false)
    expect(isLoopbackAddress("")).toBe(false)
    expect(isLoopbackAddress(null)).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })
})

describe("createAuthMiddleware loopback exemption", () => {
  const dashboardPaths = ["/usage", "/token-usage", "/token-usage/events"]

  test("loopback request to /usage with no api key passes auth", async () => {
    const app = buildApp({
      apiKeys: ["secret"],
      loopbackOnlyPaths: dashboardPaths,
      ip: "127.0.0.1",
    })

    const res = await app.request("/usage")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("usage-ok")
  })

  test("loopback exemption covers ::1 and ::ffff:127.0.0.1", async () => {
    for (const ip of ["::1", "::ffff:127.0.0.1"]) {
      const app = buildApp({
        apiKeys: ["secret"],
        loopbackOnlyPaths: dashboardPaths,
        ip,
      })
      const res = await app.request("/token-usage")
      expect(res.status).toBe(200)
    }
  })

  test("non-loopback request to /usage with no api key is rejected", async () => {
    const app = buildApp({
      apiKeys: ["secret"],
      loopbackOnlyPaths: dashboardPaths,
      ip: "203.0.113.7",
    })

    const res = await app.request("/usage")
    expect(res.status).toBe(401)
  })

  test("non-loopback request to /usage with valid api key passes", async () => {
    const app = buildApp({
      apiKeys: ["secret"],
      loopbackOnlyPaths: dashboardPaths,
      ip: "203.0.113.7",
    })

    const res = await app.request("/usage", {
      headers: { "x-api-key": "secret" },
    })
    expect(res.status).toBe(200)
  })

  test("loopback request to /v1/messages with no api key is still rejected", async () => {
    const app = buildApp({
      apiKeys: ["secret"],
      loopbackOnlyPaths: dashboardPaths,
      ip: "127.0.0.1",
    })

    const res = await app.request("/v1/messages", { method: "POST" })
    expect(res.status).toBe(401)
  })

  test("missing peer IP is treated as non-loopback", async () => {
    const app = buildApp({
      apiKeys: ["secret"],
      loopbackOnlyPaths: dashboardPaths,
      ip: null,
    })

    const res = await app.request("/usage")
    expect(res.status).toBe(401)
  })
})

describe("createAuthMiddleware allowUnauthenticatedPrefixes", () => {
  test("exact prefix match bypasses auth", async () => {
    const app = buildApp({
      apiKeys: ["secret"],
      allowUnauthenticatedPrefixes: ["/settings"],
      ip: "203.0.113.7",
    })
    const res = await app.request("/settings")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("settings-ok")
  })

  test("sub-path under prefix bypasses auth", async () => {
    const app = buildApp({
      apiKeys: ["secret"],
      allowUnauthenticatedPrefixes: ["/settings"],
      ip: "203.0.113.7",
    })
    const res = await app.request("/settings/assets/index.js")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("asset-ok")
  })

  test("similar-named path does not bypass auth", async () => {
    const app = buildApp({
      apiKeys: ["secret"],
      allowUnauthenticatedPrefixes: ["/settings"],
      ip: "203.0.113.7",
    })
    const res = await app.request("/settings-not-this-one")
    expect(res.status).toBe(401)
  })

  test("protected route still requires auth when prefix configured", async () => {
    const app = buildApp({
      apiKeys: ["secret"],
      allowUnauthenticatedPrefixes: ["/settings"],
      ip: "203.0.113.7",
    })
    const res = await app.request("/v1/messages", { method: "POST" })
    expect(res.status).toBe(401)
  })
})

describe("createAuthMiddleware key matching", () => {
  test("unknown key rejected when enforcing", async () => {
    const app = buildApp({ apiKeys: ["specific"], ip: "203.0.113.7" })
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "other" },
    })
    expect(res.status).toBe(401)
  })
})

describe("createUnauthorizedResponse body and headers", () => {
  test("401 body shape matches Anthropic-style error envelope", async () => {
    const app = buildApp({ apiKeys: ["secret"], ip: "203.0.113.7" })
    const res = await app.request("/v1/messages", { method: "POST" })
    expect(res.status).toBe(401)
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer realm="copilot-api"',
    )
    const body = (await res.json()) as {
      error: { message: string; type: string }
    }
    expect(body).toEqual({
      error: {
        message: "Unauthorized",
        type: "authentication_error",
      },
    })
    expect(body.error.message).toBe("Unauthorized")
    expect(body.error.type).toBe("authentication_error")
  })

  test("WWW-Authenticate header is also set when key is wrong, not missing", async () => {
    const app = buildApp({ apiKeys: ["secret"], ip: "203.0.113.7" })
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "wrong" },
    })
    expect(res.status).toBe(401)
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer realm="copilot-api"',
    )
  })
})

describe("createAuthMiddleware Authorization: Bearer path", () => {
  test("Authorization: Bearer <key> is accepted", async () => {
    const app = buildApp({ apiKeys: ["secret"], ip: "203.0.113.7" })
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    })
    expect(res.status).toBe(200)
  })

  test("Authorization header is case-insensitive for the scheme", async () => {
    const app = buildApp({ apiKeys: ["secret"], ip: "203.0.113.7" })
    for (const scheme of ["bearer", "BEARER", "BeArEr"]) {
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { authorization: `${scheme} secret` },
      })
      expect(res.status).toBe(200)
    }
  })

  test("Authorization with non-Bearer scheme is rejected", async () => {
    const app = buildApp({ apiKeys: ["secret"], ip: "203.0.113.7" })
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { authorization: "Basic c2VjcmV0" },
    })
    expect(res.status).toBe(401)
  })

  test("Authorization with Bearer but empty token is rejected", async () => {
    const app = buildApp({ apiKeys: ["secret"], ip: "203.0.113.7" })
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer   " },
    })
    expect(res.status).toBe(401)
  })

  test("Authorization with multiple whitespace separators still parses", async () => {
    const app = buildApp({ apiKeys: ["secret"], ip: "203.0.113.7" })
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { authorization: "   Bearer    secret   " },
    })
    expect(res.status).toBe(200)
  })

  test("Bearer token with internal spaces joins parts back with space", async () => {
    // A multi-segment token round-trips: split on \s+ then join with " ".
    // If join used "" instead of " ", the resulting string would not
    // match the configured key.
    const app = buildApp({ apiKeys: ["part1 part2"], ip: "203.0.113.7" })
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer part1 part2" },
    })
    expect(res.status).toBe(200)
  })

  test("x-api-key takes precedence over Authorization", async () => {
    const app = buildApp({ apiKeys: ["xkey"], ip: "203.0.113.7" })
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": "xkey",
        authorization: "Bearer wrong",
      },
    })
    expect(res.status).toBe(200)
  })

  test("x-api-key surrounding whitespace is trimmed", async () => {
    const app = buildApp({ apiKeys: ["secret"], ip: "203.0.113.7" })
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "   secret   " },
    })
    expect(res.status).toBe(200)
  })

  test("blank x-api-key falls through to Authorization", async () => {
    const app = buildApp({ apiKeys: ["secret"], ip: "203.0.113.7" })
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": "   ",
        authorization: "Bearer secret",
      },
    })
    expect(res.status).toBe(200)
  })
})

function ctxWithHeaders(headers: Record<string, string>): Context {
  return {
    req: {
      header(name: string) {
        return headers[name.toLowerCase()]
      },
    },
  } as unknown as Context
}

describe("extractRequestApiKey unit", () => {
  test("returns trimmed x-api-key when present", () => {
    const c = ctxWithHeaders({ "x-api-key": "  abc  " })
    expect(extractRequestApiKey(c)).toBe("abc")
  })

  test("returns null when no headers present", () => {
    const c = ctxWithHeaders({})
    expect(extractRequestApiKey(c)).toBeNull()
  })

  test("returns null for non-bearer Authorization", () => {
    const c = ctxWithHeaders({ authorization: "Token abc" })
    expect(extractRequestApiKey(c)).toBeNull()
  })

  test("returns bearer token after trimming", () => {
    const c = ctxWithHeaders({ authorization: "Bearer abc" })
    expect(extractRequestApiKey(c)).toBe("abc")
  })

  test("returns null when bearer token is whitespace-only", () => {
    const c = ctxWithHeaders({ authorization: "Bearer    " })
    expect(extractRequestApiKey(c)).toBeNull()
  })

  test("multi-word bearer rejoins with single space", () => {
    const c = ctxWithHeaders({ authorization: "Bearer one  two   three" })
    expect(extractRequestApiKey(c)).toBe("one two three")
  })
})

describe("createAuthMiddleware OPTIONS bypass", () => {
  test("OPTIONS request bypasses auth by default", async () => {
    const app = new Hono()
    app.use(
      "*",
      createAuthMiddleware({
        getApiKeys: () => ["secret"],
        isEnforcing: () => true,
        getRequestIp: () => "203.0.113.7",
      }),
    )
    app.options("/v1/messages", (c) => c.text("opts-ok"))
    const res = await app.request("/v1/messages", { method: "OPTIONS" })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("opts-ok")
  })

  test("OPTIONS bypass can be disabled", async () => {
    const app = new Hono()
    app.use(
      "*",
      createAuthMiddleware({
        getApiKeys: () => ["secret"],
        isEnforcing: () => true,
        allowOptionsBypass: false,
        getRequestIp: () => "203.0.113.7",
      }),
    )
    app.options("/v1/messages", (c) => c.text("opts-ok"))
    const res = await app.request("/v1/messages", { method: "OPTIONS" })
    expect(res.status).toBe(401)
  })

  test("non-OPTIONS requests still require auth when bypass is enabled", async () => {
    const app = new Hono()
    app.use(
      "*",
      createAuthMiddleware({
        getApiKeys: () => ["secret"],
        isEnforcing: () => true,
        allowOptionsBypass: true,
        getRequestIp: () => "203.0.113.7",
      }),
    )
    app.post("/v1/messages", (c) => c.text("ok"))
    const res = await app.request("/v1/messages", { method: "POST" })
    expect(res.status).toBe(401)
  })
})

describe("createAuthMiddleware default allowUnauthenticatedPaths", () => {
  test('default allow list contains "/"', async () => {
    const app = new Hono()
    app.use(
      "*",
      createAuthMiddleware({
        getApiKeys: () => ["secret"],
        isEnforcing: () => true,
        getRequestIp: () => "203.0.113.7",
      }),
    )
    app.get("/", (c) => c.text("root-ok"))
    const res = await app.request("/")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("root-ok")
  })

  test("default allow list does NOT cover other paths", async () => {
    const app = new Hono()
    app.use(
      "*",
      createAuthMiddleware({
        getApiKeys: () => ["secret"],
        isEnforcing: () => true,
        getRequestIp: () => "203.0.113.7",
      }),
    )
    app.get("/usage-viewer", (c) => c.text("uv-ok"))
    const res = await app.request("/usage-viewer")
    expect(res.status).toBe(401)
  })
})

describe("createAuthMiddleware bypass when no keys configured", () => {
  test("non-enforcing mode lets everything through regardless of key list", async () => {
    const app = buildApp({
      apiKeys: [],
      ip: "203.0.113.7",
      enforce: false,
    })
    const res = await app.request("/v1/messages", { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("messages-ok")
  })

  test("non-empty allow list rejects when no client key is supplied", async () => {
    const app = buildApp({ apiKeys: ["k"], ip: "203.0.113.7" })
    const res = await app.request("/v1/messages", { method: "POST" })
    expect(res.status).toBe(401)
  })
})

describe("apiKeyAllowed unit", () => {
  test("empty request key is never allowed", () => {
    expect(apiKeyAllowed(["abc"], "")).toBe(false)
    expect(apiKeyAllowed([], "")).toBe(false)
  })

  test("non-empty key matches exact entry", () => {
    expect(apiKeyAllowed(["abc", "def"], "def")).toBe(true)
  })

  test("non-empty key rejected when not present", () => {
    expect(apiKeyAllowed(["abc"], "xyz")).toBe(false)
  })
})

describe("normalizeApiKeys", () => {
  test("non-array returns []", () => {
    expect(normalizeApiKeys("nope")).toEqual([])
    expect(normalizeApiKeys(42)).toEqual([])
    expect(normalizeApiKeys({ k: 1 })).toEqual([])
  })

  test("undefined returns [] without warning", () => {
    expect(normalizeApiKeys(undefined)).toEqual([])
  })

  test("trims entries and drops empty/whitespace-only", () => {
    expect(normalizeApiKeys(["  a  ", "", "  ", "b"])).toEqual(["a", "b"])
  })

  test("drops non-string entries", () => {
    expect(normalizeApiKeys(["a", 1, null, true, "b"])).toEqual(["a", "b"])
  })

  test("dedupes", () => {
    expect(normalizeApiKeys(["a", "a", "b", "a"])).toEqual(["a", "b"])
  })

  test("warns when invalid entries are present", async () => {
    const warn = mock((..._args: Array<unknown>) => {})
    const consola = await import("consola")
    const original = consola.default.warn
    consola.default.warn = warn as unknown as typeof consola.default.warn
    try {
      normalizeApiKeys(["a", 1])
      expect(warn).toHaveBeenCalledTimes(1)
      const call = warn.mock.calls[0]?.[0]
      expect(typeof call).toBe("string")
      expect((call as string).length).toBeGreaterThan(0)
      expect(call).toContain("Invalid auth.apiKeys")
    } finally {
      consola.default.warn = original
    }
  })

  test("warns when config is not an array (and not undefined)", async () => {
    const warn = mock((..._args: Array<unknown>) => {})
    const consola = await import("consola")
    const original = consola.default.warn
    consola.default.warn = warn as unknown as typeof consola.default.warn
    try {
      normalizeApiKeys("nope")
      expect(warn).toHaveBeenCalledTimes(1)
      const msg = warn.mock.calls[0]?.[0]
      expect(typeof msg).toBe("string")
      expect((msg as string).length).toBeGreaterThan(0)
      expect(msg).toContain("Expected an array of strings")
    } finally {
      consola.default.warn = original
    }
  })

  test("does not warn when input is undefined", async () => {
    const warn = mock((..._args: Array<unknown>) => {})
    const consola = await import("consola")
    const original = consola.default.warn
    consola.default.warn = warn as unknown as typeof consola.default.warn
    try {
      normalizeApiKeys(undefined)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      consola.default.warn = original
    }
  })

  test("does not warn when input is fully valid", async () => {
    const warn = mock((..._args: Array<unknown>) => {})
    const consola = await import("consola")
    const original = consola.default.warn
    consola.default.warn = warn as unknown as typeof consola.default.warn
    try {
      normalizeApiKeys(["a", "b"])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      consola.default.warn = original
    }
  })
})

describe("defaultGetRequestIp", () => {
  test("reads ip off raw request", () => {
    const c = {
      req: { raw: { ip: "10.0.0.1" } as unknown as Request },
    } as unknown as Context
    expect(defaultGetRequestIp(c)).toBe("10.0.0.1")
  })

  test("returns null when ip is absent", () => {
    const c = {
      req: { raw: {} as unknown as Request },
    } as unknown as Context
    expect(defaultGetRequestIp(c)).toBeNull()
  })

  test("returns null when ip is null", () => {
    const c = {
      req: { raw: { ip: null } as unknown as Request },
    } as unknown as Context
    expect(defaultGetRequestIp(c)).toBeNull()
  })
})

function buildGithubApp() {
  const app = new Hono()
  app.use("*", requireGithubAuth)
  app.get("/protected", (c) => c.text("ok"))
  return app
}

describe("requireGithubAuth", () => {
  const savedToken = state.githubToken
  beforeEach(() => {
    state.githubToken = undefined
  })
  afterEach(() => {
    state.githubToken = savedToken
  })

  test("passes through when state.githubToken is set", async () => {
    state.githubToken = "ghu_token"
    const res = await buildGithubApp().request("/protected")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
  })

  test("returns 401 with exact body when no token", async () => {
    state.githubToken = undefined
    const res = await buildGithubApp().request("/protected")
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; hint: string }
    expect(body).toEqual({
      error: "not_authenticated",
      hint: "Open Settings → Account to sign in, or run `maximal auth`.",
    })
    expect(body.error).toBe("not_authenticated")
    expect(body.hint).toBe(
      "Open Settings → Account to sign in, or run `maximal auth`.",
    )
    expect(body.error.length).toBeGreaterThan(0)
    expect(body.hint.length).toBeGreaterThan(0)
  })
})

describe("getConfiguredApiKeys integration", () => {
  // Inject the config directly (getConfiguredApiKeys accepts an optional
  // AppConfig, defaulting to getConfig()). This exercises the trim/dedupe/
  // filter logic on arbitrary — including deliberately schema-invalid —
  // shapes WITHOUT a leak-prone mock.module of ~/lib/config and without
  // round-tripping through writeConfig's validation.
  test("merges legacy apiKeys + enabled apiKeyEntries, trims & dedupes", () => {
    const keys = getConfiguredApiKeys({
      auth: {
        apiKeys: ["legacy-a", "  legacy-b  ", "shared"],
        apiKeyEntries: [
          {
            id: "1",
            label: "x",
            key: "  entry-a  ",
            enabled: true,
            created_at: "",
          },
          {
            id: "2",
            label: "y",
            key: "disabled-key",
            enabled: false,
            created_at: "",
          },
          { id: "3", label: "z", key: "   ", enabled: true, created_at: "" },
          { id: "4", label: "w", key: "shared", enabled: true, created_at: "" },
        ],
      },
    })
    expect(keys).toContain("legacy-a")
    expect(keys).toContain("legacy-b")
    expect(keys).toContain("entry-a")
    expect(keys).toContain("shared")
    expect(keys).not.toContain("disabled-key")
    expect(keys).not.toContain("")
    expect(keys).not.toContain("   ")
    // dedup: "shared" appears once
    expect(keys.filter((k) => k === "shared")).toHaveLength(1)
  })

  test("returns [] when auth config is missing entirely", () => {
    expect(getConfiguredApiKeys({})).toEqual([])
  })

  test("returns [] when auth exists but apiKeyEntries is missing", () => {
    expect(getConfiguredApiKeys({ auth: {} })).toEqual([])
  })
})
