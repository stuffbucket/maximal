import type {
  Context,
  PluginModule,
  ServerToolDefinition,
} from "@stuffbucket/maximal-plugin-sdk"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"
import { z } from "zod"

import { HELPER_LABEL } from "../src/apps/claude-code/config"
import { getConfig, writeConfig } from "../src/lib/config/config"
import { requestContext } from "../src/lib/http/request-context"
import { traceIdMiddleware } from "../src/lib/http/trace"
import { state } from "../src/lib/runtime-state/state"
import { closeUsageStore } from "../src/lib/token-usage"
import { messageRoutes } from "../src/routes/messages/route"
import { tokenUsageRoute } from "../src/routes/token-usage/route"
import { startTestGateway, type TestGateway } from "./helpers/plugins"
import {
  finish,
  messageStart,
  textBlock,
  toolBlock,
} from "./helpers/server-tools-loop"

// A plugin's hidden `always` server tool, end to end through `/v1/messages`:
// the real handler, the real plugin gateway composed from a fake plugin, the
// native Messages transport, and a stubbed `fetch` as the only upstream.

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const originalFetch = globalThis.fetch
const originalConfig = getConfig()
const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  lastRequestTimestamp: state.lastRequestTimestamp,
  manualApprove: state.manualApprove,
  models: state.models,
  rateLimitSeconds: state.rateLimitSeconds,
  rateLimitWait: state.rateLimitWait,
  verbose: state.verbose,
  vsCodeVersion: state.vsCodeVersion,
}

const limits = {
  max_prompt_tokens: 128_000,
  max_context_window_tokens: 400_000,
}

const createModels = () =>
  ({
    object: "list",
    data: [
      {
        capabilities: { family: "claude", limits, supports: {}, type: "chat" },
        id: "claude-test",
        model_picker_enabled: true,
        supported_endpoints: ["/v1/messages"],
      },
    ],
  }) as unknown as typeof state.models

let apiKeyLabel: string | null = null

const app = new Hono()
app.use(traceIdMiddleware)
app.use(async (_c, next) => {
  const store = requestContext.getStore()
  if (store) store.usage.apiKeyLabel = apiKeyLabel
  await next()
})
app.route("/v1/messages", messageRoutes)
app.route("/token-usage", tokenUsageRoute)

// ── the fake plugin ───────────────────────────────────────────────────

const executed: Array<{
  input: Record<string, unknown>
  client: string
  model: string
  sessionId?: string
  budget?: { plugin: string; tool: string }
}> = []

function serverTool(name: string): ServerToolDefinition {
  return {
    name,
    description: `${name} server tool`,
    input_schema: {
      type: "object",
      properties: { question: { type: "string" } },
    },
    render: "hidden",
    offer: "always",
    execute: (input, call) => {
      executed.push({
        input,
        client: call.client,
        model: call.model,
        sessionId: call.sessionId,
        budget: call.budget,
      })
      return Promise.resolve({ content: [{ type: "text", text: "option B" }] })
    },
  }
}

function fakePlugin(register: (ctx: Context) => void): PluginModule {
  return {
    name: "fake-model",
    manifest: {
      id: "fake-model",
      kind: "model",
      displayName: "Fake model",
      description: "Registers server tools",
      settingsVersion: 1,
    },
    inject: ["serverTools"],
    Config: z.object({}),
    apply: register,
  }
}

// ── the upstream ──────────────────────────────────────────────────────

interface Upstream {
  url: string
  body: {
    tools?: Array<{ name: string }>
    messages: Array<{ role: string; content: unknown }>
  }
  bytes: string
}

/** One upstream Messages stream turn, as the SSE text Copilot would send. */
function sseTurn(stop: string, blocks: Array<Record<string, unknown>>): string {
  return [
    messageStart("msg_s", { input_tokens: 10, output_tokens: 1 }),
    ...blocks,
    ...finish(stop, 3),
  ]
    .map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("")
}

let upstream: Array<Upstream> = []
let replies: Array<Record<string, unknown>> = []

const message = (
  content: Array<Record<string, unknown>>,
  stopReason: string,
  usage = { input_tokens: 10, output_tokens: 2 },
) => ({
  id: "msg_x",
  type: "message",
  role: "assistant",
  model: "claude-test",
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage,
})

const callDecide = message(
  [
    { type: "text", text: "Let me check. " },
    {
      type: "tool_use",
      id: "toolu_1",
      name: "decide",
      input: { question: "which?" },
    },
  ],
  "tool_use",
)
const answer = message([{ type: "text", text: "Option B." }], "end_turn")

const readTool = {
  name: "Read",
  description: "Read a file",
  input_schema: { type: "object", properties: { path: { type: "string" } } },
}

const post = (
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) =>
  app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model: "claude-test",
      max_tokens: 256,
      messages: [{ role: "user", content: "which option?" }],
      tools: [readTool],
      ...body,
    }),
  })

let gateway: TestGateway | undefined

function bodyText(init: RequestInit | undefined): string {
  return typeof init?.body === "string" ? init.body : ""
}

/** The tools array an upstream call carried, as the bytes. */
function toolsOf(call: Upstream): string {
  return JSON.stringify((JSON.parse(call.bytes) as { tools: unknown }).tools)
}

function names(call: Upstream): Array<string> | undefined {
  return call.body.tools?.map((tool) => tool.name)
}

async function withPlugin(
  register: (ctx: Context) => void = (ctx) => {
    ctx.serverTools.register(serverTool("decide"))
  },
): Promise<void> {
  const started = await startTestGateway([fakePlugin(register)], ["fake-model"])
  gateway = started
}

beforeEach(async () => {
  consola.level = 1
  process.env[DB_PATH_ENV] = ":memory:"
  writeConfig({ modelMappings: [] })
  await closeUsageStore()
  apiKeyLabel = HELPER_LABEL
  upstream = []
  replies = [callDecide, answer]
  executed.length = 0
  state.accountType = "individual"
  state.copilotToken = "test-token"
  state.githubToken = "test-github-token"
  state.manualApprove = false
  state.verbose = false
  state.vsCodeVersion = "1.0.0"
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.lastRequestTimestamp = undefined
  state.models = createModels()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const text = bodyText(init)
    upstream.push({
      url: input instanceof Request ? input.url : input.toString(),
      body: JSON.parse(text) as Upstream["body"],
      bytes: text,
    })
    const reply = replies[Math.min(upstream.length - 1, replies.length - 1)]
    return Promise.resolve(Response.json(reply))
  }) as unknown as typeof fetch
})

afterEach(async () => {
  consola.level = 3
  const running = gateway
  gateway = undefined
  await running?.dispose()
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  Object.assign(state, originalState)
  writeConfig(originalConfig)
})

describe("/v1/messages with a plugin's hidden server tool", () => {
  test("runs the tool inside the loop and hides it from the client", async () => {
    await withPlugin()

    const response = await post({}, { "x-session-id": "s-1" })
    const json = (await response.json()) as {
      content: Array<{ type: string; text?: string }>
      stop_reason: string
      usage: { input_tokens: number; output_tokens: number }
    }

    expect(response.status).toBe(200)
    expect(upstream).toHaveLength(2)
    for (const call of upstream) expect(call.url).toContain("/v1/messages")
    // The client's tool first, then ours.
    expect(names(upstream[0])).toEqual(["Read", "decide"])
    // The tool ran once, told who asked and the budget scope it books to.
    expect(executed).toHaveLength(1)
    expect(executed[0]).toMatchObject({
      input: { question: "which?" },
      client: "claude-code",
      model: "claude-test",
      budget: { plugin: "fake-model", tool: "decide" },
    })
    expect(executed[0].sessionId).toBeString()
    // The client sees the text and nothing of the call.
    expect(json.content).toEqual([
      { type: "text", text: "Let me check. " },
      { type: "text", text: "Option B." },
    ])
    expect(json.stop_reason).toBe("end_turn")
    expect(json.usage).toEqual({ input_tokens: 20, output_tokens: 4 })
    // The second turn carried the result back to the model.
    expect(JSON.stringify(upstream[1].body.messages.at(-1))).toContain(
      "option B",
    )
  })

  test("the tools array is byte-identical on every turn", async () => {
    await withPlugin()

    await post({})

    expect(upstream).toHaveLength(2)
    expect(toolsOf(upstream[1])).toBe(toolsOf(upstream[0]))
  })

  test("records the request's usage once, under the messages endpoint", async () => {
    await withPlugin()

    await post({})

    const events = await app.request(
      "/token-usage/events?period=day&page=1&page_size=10",
    )
    const page = (await events.json()) as {
      items: Array<{ endpoint: string; input_tokens: number }>
    }
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      endpoint: "messages",
      input_tokens: 20,
    })
  })

  test("streams: the client sees text blocks only", async () => {
    await withPlugin()
    const streams = [
      sseTurn("tool_use", [
        ...textBlock(0, "Checking. "),
        ...toolBlock(1, {
          id: "toolu_1",
          name: "decide",
          input: { question: "which?" },
        }),
      ]),
      sseTurn("end_turn", textBlock(0, "Option B.")),
    ]
    let turnIndex = 0
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const text = bodyText(init)
      upstream.push({
        url: "",
        body: JSON.parse(text) as Upstream["body"],
        bytes: text,
      })
      return Promise.resolve(
        new Response(streams[turnIndex++], {
          headers: { "content-type": "text/event-stream" },
        }),
      )
    }) as unknown as typeof fetch

    const response = await post({ stream: true })
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(upstream).toHaveLength(2)
    expect(executed).toHaveLength(1)
    expect(text).toContain("Checking. ")
    expect(text).toContain("Option B.")
    expect(text).not.toContain("tool_use")
    expect(text).not.toContain("event: error")
    expect(text.match(/event: message_stop/gu)).toHaveLength(1)
  })
})

describe("/v1/messages decides who gets a plugin's server tool", () => {
  test("offers the tool on a subagent turn too", async () => {
    await withPlugin()

    await post({}, { "x-claude-code-request-class": "subagent" })

    expect(names(upstream[0])).toEqual(["Read", "decide"])
  })

  test("leaves a compaction alone: ordinary Messages flow, no tool offered", async () => {
    await withPlugin()
    replies = [answer]

    await post({}, { "x-claude-code-compaction": "manual" })

    expect(upstream).toHaveLength(1)
    expect(names(upstream[0])).toEqual(["Read"])
    expect(executed).toEqual([])
  })

  test("leaves another client alone", async () => {
    await withPlugin()
    apiKeyLabel = null
    replies = [answer]

    await post({})

    expect(upstream).toHaveLength(1)
    expect(names(upstream[0])).toEqual(["Read"])
  })

  test("a client tool with the same name wins and the request is served as before", async () => {
    await withPlugin()
    replies = [answer]

    await post({ tools: [readTool, { ...readTool, name: "decide" }] })

    expect(upstream).toHaveLength(1)
    expect(names(upstream[0])).toEqual(["Read", "decide"])
    expect(executed).toEqual([])
    // Ours would have been a second declaration of the name.
    expect(
      upstream[0].body.tools?.filter((tool) => tool.name === "decide"),
    ).toHaveLength(1)
  })

  test("without the plugin running, nothing changes", async () => {
    replies = [answer]

    const response = await post({})

    expect(response.status).toBe(200)
    expect(upstream).toHaveLength(1)
    expect(names(upstream[0])).toEqual(["Read"])
  })

  test("stopping the plugin takes the tool away", async () => {
    await withPlugin()
    await gateway?.gateway.reconcile({})
    replies = [answer]

    await post({})

    expect(names(upstream[0])).toEqual(["Read"])
  })
})
