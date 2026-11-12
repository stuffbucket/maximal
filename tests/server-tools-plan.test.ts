import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"

import {
  applyServerToolDeclarations,
  planServerTools,
  type ServerToolRequest,
} from "~/routes/messages/server-tools/plan"
import {
  type ServerToolListing,
  type ServerToolRun,
} from "~/routes/messages/server-tools/types"
import { webToolListings } from "~/routes/messages/web-tools/listings"

import { FakeExecutor } from "./helpers/fake-executor"

const request: ServerToolRequest = {
  client: "claude-code",
  model: "claude-sonnet-4.6",
  sessionId: "session-1",
  compact: false,
  signal: new AbortController().signal,
}

const nothing: ServerToolRun = {
  toolResult: { type: "tool_result", tool_use_id: "t", content: "ok" },
  ok: true,
}

function hidden(
  name: string,
  overrides: Partial<ServerToolListing> = {},
): ServerToolListing {
  return {
    owner: "fake-plugin",
    name,
    description: `${name} description`,
    input_schema: { type: "object", properties: { q: { type: "string" } } },
    render: "hidden",
    offer: "always",
    clients: ["claude-code"],
    run: () => Promise.resolve(nothing),
    ...overrides,
  }
}

const readTool = {
  name: "Read",
  description: "Read a file",
  input_schema: { type: "object", properties: { path: { type: "string" } } },
}

function payload(
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload {
  return {
    model: request.model,
    max_tokens: 1024,
    messages: [{ role: "user", content: "hello" }],
    tools: [readTool],
    ...overrides,
  }
}

function bytes(order: ReadonlyArray<ServerToolListing>): string {
  const body = payload()
  applyServerToolDeclarations(body, plan(order, { payload: body }))
  return JSON.stringify(body.tools)
}

function warnings() {
  const seen: Array<string> = []
  return {
    seen,
    logger: { warn: (message: string) => void seen.push(message) },
  }
}

function plan(
  listings: ReadonlyArray<ServerToolListing>,
  overrides: {
    payload?: AnthropicMessagesPayload
    request?: Partial<ServerToolRequest>
    declared?: Array<string>
    logger?: { warn(message: string): void }
  } = {},
) {
  return planServerTools({
    payload: overrides.payload ?? payload(),
    listings,
    declared: new Set(overrides.declared),
    request: { ...request, ...overrides.request },
    logger: overrides.logger ?? { warn: () => {} },
  })
}

describe("planServerTools: what is offered", () => {
  test("offers an always tool to an allowed client on an agent turn", () => {
    const result = plan([hidden("decide")])
    expect([...result.tools.keys()]).toEqual(["decide"])
    expect(result.offersAlways).toBe(true)
    expect(result.tools.get("decide")).toMatchObject({
      owner: "fake-plugin",
      render: "hidden",
      hidden: true,
    })
  })

  test("offers it to subagent turns too: the plan does not look at the initiator", () => {
    // Subagent turns carry no flag the planner reads; they are agent turns.
    expect(plan([hidden("decide")]).tools.has("decide")).toBe(true)
  })

  test("does not offer an always tool to a client it does not allow", () => {
    expect(
      plan([hidden("decide")], { request: { client: "codex" } }).tools.size,
    ).toBe(0)
    expect(
      plan([hidden("decide", { clients: ["codex"] })], {
        request: { client: "codex" },
      }).tools.has("decide"),
    ).toBe(true)
  })

  test("does not offer an always tool on a compaction", () => {
    const result = plan([hidden("decide")], { request: { compact: true } })
    expect(result.tools.size).toBe(0)
    expect(result.offersAlways).toBe(false)
  })

  test("does not offer an always tool to a request with no tools of its own", () => {
    expect(
      plan([hidden("decide")], { payload: payload({ tools: [] }) }).tools.size,
    ).toBe(0)
    expect(
      plan([hidden("decide")], { payload: payload({ tools: undefined }) }).tools
        .size,
    ).toBe(0)
  })

  test("does not offer an always tool when the client turned tools off", () => {
    const result = plan([hidden("decide")], {
      payload: payload({ tool_choice: { type: "none" } }),
    })
    expect(result.tools.size).toBe(0)
  })

  test("offers a when-client-declares tool only when the client declared it", () => {
    const listings = webToolListings(
      {
        declarations: [{ type: "web_search_20250305", name: "web_search" }],
        hasSearch: true,
        hasFetch: false,
      },
      new FakeExecutor(),
    )
    expect([
      ...plan(listings, { declared: ["web_search"] }).tools.keys(),
    ]).toEqual(["web_search"])
    expect(plan(listings).tools.size).toBe(0)
    // Whatever the client is, and without any compaction check: this is how
    // web tools have always worked.
    expect(
      plan(listings, {
        declared: ["web_search"],
        request: { client: "other", compact: true },
        payload: payload({ tools: [] }),
      }).offersAlways,
    ).toBe(false)
  })
})

describe("planServerTools: name collisions", () => {
  test("a client tool with the same name wins, and the skip is logged", () => {
    const { seen, logger } = warnings()
    const result = plan([hidden("Read"), hidden("decide")], { logger })
    expect([...result.tools.keys()]).toEqual(["decide"])
    expect(result.declarations.map((d) => d.name)).toEqual(["decide"])
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('"Read"')
    expect(seen[0]).toContain("fake-plugin")
  })

  test("a collision alone leaves the request out of the loop", () => {
    const result = plan([hidden("Read")])
    expect(result.tools.size).toBe(0)
    expect(result.offersAlways).toBe(false)
    const body = payload()
    applyServerToolDeclarations(body, result)
    expect(body.tools).toEqual([readTool])
  })

  test("two providers offering one name: the one listed first wins and the other is logged", () => {
    const { seen, logger } = warnings()
    const result = plan(
      [
        hidden("decide", { owner: "first" }),
        hidden("decide", { owner: "second" }),
      ],
      { logger },
    )
    expect(result.tools.get("decide")?.owner).toBe("first")
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain("second")
  })

  test("a client's own web_search next to the declared server tool is still ours", () => {
    const listings = webToolListings(
      {
        declarations: [{ type: "web_search_20250305", name: "web_search" }],
        hasSearch: true,
        hasFetch: false,
      },
      new FakeExecutor(),
    )
    const body = payload({
      tools: [
        readTool,
        { name: "web_search", description: "mine", input_schema: {} },
      ],
    })
    const { seen, logger } = warnings()
    const result = plan(listings, {
      payload: body,
      declared: ["web_search"],
      logger,
    })
    expect(result.tools.has("web_search")).toBe(true)
    // Not declared twice.
    applyServerToolDeclarations(body, result)
    expect(
      body.tools?.filter((tool) => tool.name === "web_search"),
    ).toHaveLength(1)
    expect(seen).toEqual([])
  })
})

describe("planServerTools: the tools array", () => {
  const listings = [
    hidden("zeta"),
    hidden("alpha"),
    hidden("mid", { description: "a different description" }),
  ]

  test("declarations are sorted by name and appended after the client's tools", () => {
    const body = payload()
    const result = plan(listings, { payload: body })
    applyServerToolDeclarations(body, result)
    expect(body.tools?.map((tool) => tool.name)).toEqual([
      "Read",
      "alpha",
      "mid",
      "zeta",
    ])
    expect(body.tools?.[0]).toBe(readTool)
  })

  test("the array is byte-identical whatever order the providers list in, and across turns", () => {
    const first = bytes(listings)
    expect(bytes([...listings].reverse())).toBe(first)
    expect(bytes([listings[1], listings[2], listings[0]])).toBe(first)
    // A later turn of the same conversation plans again from the same tools.
    for (let turn = 0; turn < 5; turn++) expect(bytes(listings)).toBe(first)
  })

  test("the declaration is exactly name, description, input_schema", () => {
    const result = plan([hidden("decide")])
    expect(JSON.stringify(result.declarations)).toBe(
      JSON.stringify([
        {
          name: "decide",
          description: "decide description",
          input_schema: {
            type: "object",
            properties: { q: { type: "string" } },
          },
        },
      ]),
    )
  })

  test("applying is idempotent and never shares the schema with the listing", () => {
    const listing = hidden("decide")
    const body = payload()
    const result = plan([listing], { payload: body })
    applyServerToolDeclarations(body, result)
    applyServerToolDeclarations(body, result)
    expect(body.tools?.map((tool) => tool.name)).toEqual(["Read", "decide"])
    const declared = body.tools?.[1]?.input_schema as { properties: object }
    expect(declared).not.toBe(listing.input_schema)
    declared.properties = {}
    expect(listing.input_schema.properties).toEqual({ q: { type: "string" } })
  })

  test("a plan with no tools leaves the payload alone", () => {
    const body = payload({ tools: undefined })
    applyServerToolDeclarations(body, plan([], { payload: body }))
    expect(body.tools).toBeUndefined()
  })

  test("planning does not touch the payload", () => {
    const body = payload()
    const before = JSON.stringify(body)
    plan(listings, { payload: body })
    expect(JSON.stringify(body)).toBe(before)
  })
})

describe("planned tools run with the request's context", () => {
  test("the listing hears the signal, session, model and client", async () => {
    const seen: Array<unknown> = []
    const listing = hidden("decide", {
      run: (toolUse, call) => {
        seen.push({ id: toolUse.id, call })
        return Promise.resolve(nothing)
      },
    })
    const result = plan([listing])
    await result.tools.get("decide")?.run({
      type: "tool_use",
      id: "toolu_1",
      name: "decide",
      input: {},
    })
    expect(seen).toEqual([
      {
        id: "toolu_1",
        call: {
          signal: request.signal,
          sessionId: "session-1",
          model: "claude-sonnet-4.6",
          client: "claude-code",
        },
      },
    ])
  })
})
