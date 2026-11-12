import * as decisions from "@stuffbucket/maximal-plugin-decisions"
import * as systemone from "@stuffbucket/maximal-plugin-systemone"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"

import { HELPER_LABEL } from "../src/apps/claude-code/config"
import { getConfig, writeConfig } from "../src/lib/config/config"
import { requestContext } from "../src/lib/http/request-context"
import { traceIdMiddleware } from "../src/lib/http/trace"
import { state } from "../src/lib/runtime-state/state"
import { closeUsageStore } from "../src/lib/token-usage"
import { messageRoutes } from "../src/routes/messages/route"
import { startTestGateway, type TestGateway } from "./helpers/plugins"

// The decisions and SystemOne plugins' hidden server tools, end to end
// through `/v1/messages`: the real handler, the real plugins on the real
// plugin host and Copilot provider, and a stubbed `fetch` as the only
// upstream, answering the Messages turns and the decision models' endpoints.

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

const chatModel = {
  capabilities: { family: "claude", limits, supports: {}, type: "chat" },
  id: "claude-test",
  model_picker_enabled: true,
  supported_endpoints: ["/v1/messages"],
}

const decisionModel = (id: string) => ({
  capabilities: { family: id, limits: {}, supports: {}, type: "decisions" },
  id,
  model_picker_enabled: false,
})

const createModels = (ids: Array<string>) =>
  ({
    object: "list",
    data: [chatModel, ...ids.map((id) => decisionModel(id))],
  }) as unknown as typeof state.models

const app = new Hono()
app.use(traceIdMiddleware)
app.use(async (_c, next) => {
  const store = requestContext.getStore()
  if (store) store.usage.apiKeyLabel = HELPER_LABEL
  await next()
})
app.route("/v1/messages", messageRoutes)

interface Upstream {
  path: string
  body: Record<string, unknown> & {
    tools?: Array<{ name: string }>
    messages: Array<{ role: string; content: unknown }>
  }
}

let upstream: Array<Upstream> = []
let messageReplies: Array<Record<string, unknown>> = []
/** The decision models' replies, by endpoint path. */
let decisionReplies: Partial<Record<string, () => Response>> = {}

const message = (
  content: Array<Record<string, unknown>>,
  stopReason: string,
) => ({
  id: "msg_x",
  type: "message",
  role: "assistant",
  model: "claude-test",
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 2 },
})

const callTool = (name: string, input: Record<string, unknown>) =>
  message(
    [
      { type: "text", text: "Checking. " },
      { type: "tool_use", id: "toolu_1", name, input },
    ],
    "tool_use",
  )
const answer = message([{ type: "text", text: "Done." }], "end_turn")

const readTool = {
  name: "Read",
  description: "Read a file",
  input_schema: { type: "object", properties: { path: { type: "string" } } },
}

const post = () =>
  app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-test",
      max_tokens: 256,
      messages: [{ role: "user", content: "triage this" }],
      tools: [readTool],
    }),
  })

let gateway: TestGateway | undefined

const names = (call: Upstream) => call.body.tools?.map((tool) => tool.name)
const decisionCalls = () =>
  upstream.filter((call) => !call.path.endsWith("/v1/messages"))

async function withPlugins(models: Array<string>) {
  state.models = createModels(models)
  gateway = await startTestGateway(
    [decisions, systemone],
    ["decisions", "systemone"],
  )
}

beforeEach(() => {
  consola.level = 1
  process.env[DB_PATH_ENV] = ":memory:"
  writeConfig({ modelMappings: [] })
  state.accountType = "individual"
  state.copilotToken = "test-token"
  state.githubToken = "test-github-token"
  state.manualApprove = false
  state.verbose = false
  state.vsCodeVersion = "1.0.0"
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.lastRequestTimestamp = undefined
  upstream = []
  messageReplies = []
  decisionReplies = {}
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const text = typeof init?.body === "string" ? init.body : "{}"
    upstream.push({
      path: url.pathname,
      body: JSON.parse(text) as Upstream["body"],
    })
    const decision = decisionReplies[url.pathname]
    if (decision) return Promise.resolve(decision())
    const turn = upstream.filter((call) =>
      call.path.endsWith("/v1/messages"),
    ).length
    return Promise.resolve(
      Response.json(
        messageReplies[Math.min(turn - 1, messageReplies.length - 1)],
      ),
    )
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

describe("/v1/messages with the decision plugins' server tools", () => {
  test("decide runs inside the loop against /v1/decisions and the client sees only text", async () => {
    await withPlugins(["gpt-6-luna-decisions", "microsoft-decision-1"])
    decisionReplies["/v1/decisions"] = () =>
      Response.json({
        answers: [{ type: "predicate", name: "flaky", probability: 0.97 }],
        usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
      })
    messageReplies = [
      callTool("decide", {
        input: "log",
        questions: [
          { type: "predicate", name: "flaky", instructions: "Is it flaky?" },
        ],
      }),
      answer,
    ]

    const response = await post()
    const json = (await response.json()) as {
      content: Array<{ type: string; text?: string }>
    }

    expect(response.status).toBe(200)
    // Ours come after the client's, sorted by name.
    expect(names(upstream[0])).toEqual(["Read", "classify", "decide"])
    expect(decisionCalls()).toHaveLength(1)
    expect(decisionCalls()[0].path).toBe("/v1/decisions")
    expect(decisionCalls()[0].body).toMatchObject({
      model: "gpt-6-luna-decisions",
      input: "log",
    })
    const messages = upstream.filter((call) =>
      call.path.endsWith("/v1/messages"),
    )
    expect(messages).toHaveLength(2)
    expect(JSON.stringify(messages[1].body.messages.at(-1))).toContain(
      "flaky: predicate, probability 0.97",
    )
    expect(json.content).toEqual([
      { type: "text", text: "Checking. " },
      { type: "text", text: "Done." },
    ])
  })

  test("classify runs against /v1/systemone", async () => {
    await withPlugins(["gpt-6-luna-decisions", "microsoft-decision-1"])
    decisionReplies["/v1/systemone"] = () =>
      Response.json({
        answers: { refund: { type: "noul", noul: 0.02 } },
        usage: { input_tokens: 5, output_tokens: 1 },
      })
    messageReplies = [
      callTool("classify", {
        state: "please refund me",
        questions: {
          refund: { type: "noul", instructions: "Asks for money?" },
        },
      }),
      answer,
    ]

    const response = await post()

    expect(response.status).toBe(200)
    expect(decisionCalls()).toHaveLength(1)
    expect(decisionCalls()[0].path).toBe("/v1/systemone")
    expect(decisionCalls()[0].body).toMatchObject({
      model: "microsoft-decision-1",
      state: "please refund me",
    })
    expect(
      JSON.stringify(
        upstream
          .filter((call) => call.path.endsWith("/v1/messages"))[1]
          .body.messages.at(-1),
      ),
    ).toContain("refund: noul, probability 0.02")
  })

  test("an upstream failure reaches the model as an error result and the turn still completes", async () => {
    await withPlugins(["gpt-6-luna-decisions"])
    decisionReplies["/v1/decisions"] = () =>
      new Response("Bad Request", { status: 400 })
    messageReplies = [
      callTool("decide", {
        input: "log",
        questions: [{ type: "predicate", name: "q", instructions: "?" }],
      }),
      answer,
    ]

    const response = await post()

    expect(response.status).toBe(200)
    const second = upstream.filter((call) =>
      call.path.endsWith("/v1/messages"),
    )[1]
    expect(JSON.stringify(second.body.messages.at(-1))).toContain(
      "Failed to create decisions",
    )
  })

  test("a model the account doesn't have is not offered", async () => {
    await withPlugins(["gpt-6-luna-decisions"])
    messageReplies = [answer]

    await post()

    // SystemOne's model is missing from the catalog, so only decide.
    expect(names(upstream[0])).toEqual(["Read", "decide"])
  })

  test("with neither model, the request is served as before", async () => {
    await withPlugins([])
    messageReplies = [answer]

    await post()

    expect(names(upstream[0])).toEqual(["Read"])
  })

  test("the tools array is byte-identical on every turn", async () => {
    await withPlugins(["gpt-6-luna-decisions", "microsoft-decision-1"])
    decisionReplies["/v1/decisions"] = () =>
      Response.json({
        answers: [{ type: "predicate", name: "q", probability: 1 }],
      })
    messageReplies = [
      callTool("decide", {
        input: "x",
        questions: [{ type: "predicate", name: "q", instructions: "?" }],
      }),
      answer,
    ]

    await post()

    const messages = upstream.filter((call) =>
      call.path.endsWith("/v1/messages"),
    )
    expect(JSON.stringify(messages[1].body.tools)).toBe(
      JSON.stringify(messages[0].body.tools),
    )
  })
})
