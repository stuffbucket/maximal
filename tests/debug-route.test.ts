import { afterEach, describe, expect, it } from "bun:test"

import { state } from "~/lib/state"
import { server } from "~/server"

const originalVerbose = state.verbose

afterEach(() => {
  state.verbose = originalVerbose
})

describe("/_debug/state route", () => {
  it("returns 404 when state.verbose is false", async () => {
    state.verbose = false
    const res = await server.request("/_debug/state")
    expect(res.status).toBe(404)
  })

  it("returns 200 with shape when state.verbose is true", async () => {
    state.verbose = true
    const res = await server.request("/_debug/state")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      runtime: Record<string, unknown>
      config: Record<string, unknown>
      executor: { web_tools: string }
      caches: Array<{ name: string; kind: string }>
      secrets: Array<{ name: string; source: string }>
    }
    expect(body.runtime.verbose).toBe(true)
    expect(body.executor.web_tools).toMatch(/Executor$/)
    expect(Array.isArray(body.secrets)).toBe(true)
    const cacheNames = body.caches.map((c) => c.name)
    expect(cacheNames).toContain("models")
    expect(cacheNames).toContain("copilot_token")
  })

  it("never echoes the OLLAMA_API_KEY value in response body", async () => {
    state.verbose = true
    const sentinel = "secret-route-sentinel-XYZ123"
    const prev = process.env.OLLAMA_API_KEY
    process.env.OLLAMA_API_KEY = sentinel
    let text: string
    try {
      const res = await server.request("/_debug/state")
      text = await res.text()
    } finally {
      /* eslint-disable require-atomic-updates -- single-test scope; no concurrent env mutation possible */
      if (prev === undefined) delete process.env.OLLAMA_API_KEY
      else process.env.OLLAMA_API_KEY = prev
      /* eslint-enable require-atomic-updates */
    }
    expect(text).not.toContain(sentinel)
  })
})
