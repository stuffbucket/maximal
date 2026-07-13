import { describe, expect, test } from "bun:test"

import { BUILD_VERSION } from "~/lib/update/build-info"
import { server } from "~/server"

describe("x-maximal-version response header", () => {
  test("GET /status stamps the build version", async () => {
    const res = await server.request("/status")
    expect(res.status).toBe(200)
    expect(res.headers.get("x-maximal-version")).toBe(BUILD_VERSION)
  })

  test("redirect responses are stamped too", async () => {
    const res = await server.request("/settings")
    expect(res.status).toBe(301)
    expect(res.headers.get("x-maximal-version")).toBe(BUILD_VERSION)
  })
})
