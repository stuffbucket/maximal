import { describe, expect, test } from "bun:test"

import { keepLoopbackOffProxy } from "~/lib/http/proxy"

describe("keepLoopbackOffProxy", () => {
  test("adds the loopback hosts to an empty NO_PROXY", () => {
    const env: Record<string, string | undefined> = {}
    keepLoopbackOffProxy(env)
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost,::1")
    expect(env.no_proxy).toBe(env.NO_PROXY)
  })

  test("keeps the hosts already there, adding only what's missing", () => {
    const env: Record<string, string | undefined> = {
      no_proxy: "corp.example, localhost",
    }
    keepLoopbackOffProxy(env)
    expect(env.NO_PROXY).toBe("corp.example,localhost,127.0.0.1,::1")
  })

  test("changes nothing when loopback is already covered", () => {
    const env: Record<string, string | undefined> = {
      NO_PROXY: "::1,localhost,127.0.0.1",
    }
    keepLoopbackOffProxy(env)
    expect(env).toEqual({ NO_PROXY: "::1,localhost,127.0.0.1" })
  })
})
