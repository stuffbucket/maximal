import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  createAuthMiddleware,
  isLoopbackAddress,
} from "../src/lib/request-auth"

function buildApp(opts: {
  apiKeys: Array<string>
  loopbackOnlyPaths?: Array<string>
  allowUnauthenticatedPrefixes?: Array<string>
  ip: string | null
}) {
  const app = new Hono()
  app.use(
    "*",
    createAuthMiddleware({
      getApiKeys: () => opts.apiKeys,
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
