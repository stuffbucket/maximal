/**
 * Browser `Origin` guard on `/settings/api/*`: with `auth.enforce` off (the
 * default) the settings API needs no key, and `cors()` lets any page script
 * the proxy — so a web page could rewrite plugin settings (point a connector
 * at its own host and collect the tokens). Requests a browser labelled with
 * a foreign `Origin` are refused; CLI / shell calls with no `Origin`, and
 * Maximal's own UI, pass.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { hasForeignOrigin, isTrustedOrigin } from "~/lib/auth/origin"
import { getConfig } from "~/lib/config/config"
import { server } from "~/server"

import {
  definePlugin,
  startTestGateway,
  type TestGateway,
} from "./helpers/plugins"

const demo = definePlugin("demo", (ctx) => {
  ctx.tools.register({
    name: "echo",
    description: "Echo.",
    inputSchema: { type: "object" },
    execute: () => Promise.resolve({ content: [] }),
  })
})

let plugins: TestGateway

beforeEach(async () => {
  plugins = await startTestGateway([demo], ["demo"])
})

afterEach(async () => {
  await plugins.dispose()
})

const EVIL = "https://evil.example"

function patch(origin: string | undefined, host = "localhost:4141") {
  return server.request(`http://${host}/settings/api/plugins/demo`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      host,
      ...(origin === undefined ? {} : { origin }),
    },
    body: JSON.stringify({ config: { endpoint: "http://evil.example/mcp" } }),
  })
}

function savedEndpoint(): unknown {
  const file = path.join(plugins.storageRoot, "demo", "settings.json")
  if (!fs.existsSync(file)) return undefined
  const document = JSON.parse(fs.readFileSync(file).toString()) as {
    config?: { endpoint?: string }
  }
  return document.config?.endpoint
}

describe("settings API cross-origin writes", () => {
  test("a foreign Origin cannot change plugin config, and nothing is written", async () => {
    for (const origin of [EVIL, "null", "http://localhost.evil.example:4141"]) {
      const response = await patch(origin)
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({
        error: { code: "ORIGIN_REJECTED" },
      })
    }
    expect(savedEndpoint()).toBeUndefined()
  })

  test("the other plugin routes (PUT, POST) are guarded too", async () => {
    const headers = { origin: EVIL, "content-type": "application/json" }
    const put = await server.request(
      "/settings/api/plugins/demo/tool-permissions",
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ permissions: { echo: "block" } }),
      },
    )
    const post = await server.request(
      "/settings/api/plugins/demo/actions/anything",
      { method: "POST", headers, body: "{}" },
    )
    expect(put.status).toBe(403)
    expect(post.status).toBe(403)
  })

  test("a page on another local port or a rebound hostname is refused", async () => {
    expect((await patch("http://localhost:3000")).status).toBe(403)
    expect((await patch("http://127.0.0.1:5173")).status).toBe(403)
    // DNS rebinding: Origin and Host agree, but neither is loopback.
    expect(
      (await patch("http://rebound.example:4141", "rebound.example:4141"))
        .status,
    ).toBe(403)
  })

  test("reads are refused for a foreign Origin as well", async () => {
    const response = await server.request("/settings/api/plugins", {
      headers: { origin: EVIL },
    })
    expect(response.status).toBe(403)
  })

  test("Maximal's own UI origins and Origin-less callers still work", async () => {
    for (const origin of [
      undefined,
      "http://localhost:4141",
      "http://127.0.0.1:4141",
    ]) {
      const response = await patch(origin)
      expect(response.status).toBe(200)
    }
    expect(savedEndpoint()).toBe("http://evil.example/mcp")
    expect(getConfig().plugins?.demo.enabled).toBe(true)
  })
})

describe("origin helpers", () => {
  test("isTrustedOrigin wants http loopback on the request's own port", () => {
    expect(isTrustedOrigin("http://localhost:4141", "localhost:4141")).toBe(
      true,
    )
    expect(isTrustedOrigin("http://127.0.0.1:4141", "localhost:4141")).toBe(
      true,
    )
    expect(isTrustedOrigin("http://[::1]:4141", "[::1]:4141")).toBe(true)
    expect(isTrustedOrigin("http://localhost", "localhost")).toBe(true)
    expect(isTrustedOrigin("http://localhost:4141", undefined)).toBe(true)
    expect(isTrustedOrigin("http://localhost:3000", "localhost:4141")).toBe(
      false,
    )
    expect(isTrustedOrigin("https://localhost:4141", "localhost:4141")).toBe(
      false,
    )
    expect(isTrustedOrigin("tauri://localhost", "localhost:4141")).toBe(false)
    expect(isTrustedOrigin("null", "localhost:4141")).toBe(false)
    expect(
      isTrustedOrigin("http://evil.example:4141", "evil.example:4141"),
    ).toBe(false)
  })

  test("hasForeignOrigin (the /mcp rule) accepts any loopback port", () => {
    expect(hasForeignOrigin(undefined)).toBe(false)
    expect(hasForeignOrigin("http://localhost:3000")).toBe(false)
    expect(hasForeignOrigin("https://evil.example")).toBe(true)
    expect(hasForeignOrigin("null")).toBe(true)
  })
})
