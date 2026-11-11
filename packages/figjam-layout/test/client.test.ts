// The bridge client against a stand-in bridge on a spare port: which board it targets, that a
// token is sent only when the caller passes one, and that nothing can point
// the call (and its token) somewhere other than this machine's bridge.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test"

import { tool } from "../src/client"

type Seen = {
  authorization: string | null
  agent: string | null
  body: unknown
}

const ENV_KEYS = ["FIGJAM_BRIDGE_PORT", "FIGJAM_BOARD"] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
const unset = (k: string) => Reflect.deleteProperty(process.env, k)

const seen: Array<Seen> = []
let reply: unknown = { ok: true, result: { id: "1:2" } }
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    seen.push({
      authorization: req.headers.get("authorization"),
      agent: req.headers.get("x-agent"),
      body: await req.json(),
    })
    return Response.json(reply)
  },
})

// The message a call fails with, or undefined if it succeeds.
async function failure(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

beforeAll(() => {
  for (const k of ENV_KEYS) unset(k)
  // client.ts reads the port on every call, so the stand-in bridge is always the target.
  process.env.FIGJAM_BRIDGE_PORT = String(server.port)
})

afterEach(() => {
  seen.length = 0
  reply = { ok: true, result: { id: "1:2" } }
  process.env.FIGJAM_BRIDGE_PORT = String(server.port)
  unset("FIGJAM_BOARD")
})

afterAll(async () => {
  await server.stop(true)
  for (const k of ENV_KEYS) {
    const v = savedEnv[k]
    if (v === undefined) unset(k)
    else process.env[k] = v
  }
})

describe("tool", () => {
  test("refuses to guess a board", async () => {
    expect(await failure(tool("board_tree", {}))).toContain("FIGJAM_BOARD")
    expect(seen).toEqual([])
  })

  test("posts the call for the named board without a token by default", async () => {
    process.env.FIGJAM_BOARD = "grumpy-lynx"
    const result = await tool("get_node", { id: "1:2" })
    expect(result).toEqual({ id: "1:2" })
    expect(seen).toEqual([
      {
        authorization: null,
        agent: "layout",
        body: {
          board: "grumpy-lynx",
          agent: "layout",
          name: "get_node",
          input: { id: "1:2" },
        },
      },
    ])
  })

  test("sends the token it is given", async () => {
    process.env.FIGJAM_BOARD = "b"
    await tool("status", {}, { token: "t0k" })
    expect(seen[0]?.authorization).toBe("Bearer t0k")
  })

  test("ignores the environment: no token passed, none sent", async () => {
    process.env.FIGJAM_BOARD = "b"
    process.env.FIGJAM_TOKEN = "from-env"
    try {
      await tool("status", {})
    } finally {
      unset("FIGJAM_TOKEN")
    }
    expect(seen[0]?.authorization).toBeNull()
  })

  test("turns a failed call into an error naming the tool", async () => {
    process.env.FIGJAM_BOARD = "b"
    reply = { ok: false, error: "no such node" }
    expect(await failure(tool("get_node", { id: "9:9" }))).toContain("get_node")
  })

  test("refuses a port that isn't a plain number, so the token can't leave this machine", async () => {
    process.env.FIGJAM_BOARD = "b"
    for (const port of ["1@evil.example", "4150/x", "70000", "0"]) {
      process.env.FIGJAM_BRIDGE_PORT = port
      expect(await failure(tool("status", {}, { token: "t0k" }))).toContain(
        "FIGJAM_BRIDGE_PORT",
      )
    }
    expect(seen).toEqual([])
  })

  test("doesn't follow a redirect away from the bridge", async () => {
    process.env.FIGJAM_BOARD = "b"
    const redirector = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        Response.redirect(`http://127.0.0.1:${server.port}/tool`, 307),
    })
    try {
      process.env.FIGJAM_BRIDGE_PORT = String(redirector.port)
      expect(await failure(tool("status", {}, { token: "t0k" }))).toBeDefined()
      expect(seen).toEqual([])
    } finally {
      await redirector.stop(true)
    }
  })
})
