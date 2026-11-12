import * as images from "@stuffbucket/maximal-plugin-images"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { BudgetConfig } from "../src/lib/budget/schema"
import type { Model } from "../src/services/copilot/get-models"

import { HELPER_LABEL } from "../src/apps/claude-code/config"
import { __resetProviderWindowsForTests } from "../src/lib/budget/provider-windows"
import {
  __resetBudgetServiceForTests,
  getBudgetService,
} from "../src/lib/budget/runtime"
import { getConfig, writeConfig } from "../src/lib/config/config"
import { requestContext } from "../src/lib/http/request-context"
import { traceIdMiddleware } from "../src/lib/http/trace"
import { state } from "../src/lib/runtime-state/state"
import { closeUsageStore } from "../src/lib/token-usage"
import { getNanoAiuSpend } from "../src/lib/token-usage/spend"
import { messageRoutes } from "../src/routes/messages/route"
import { tokenUsageRoute } from "../src/routes/token-usage/route"
import { startTestGateway, type TestGateway } from "./helpers/plugins"

// The image server tools end to end: the real `/v1/messages` handler, the
// real images plugin composed through the plugin gateway (real Copilot
// provider), the real budget service on an in-memory usage database and a
// stubbed `fetch` as the only upstream (Messages turns and the images API).

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const IMAGE_MODEL = "gpt-image-2.5-flare"
const AIU = 1_000_000_000
const APPROVE_ACTION = "allow-image-tools"
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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7])
const B64 = PNG.toString("base64")
const imagesReply = {
  created: 1_700_000_000,
  data: [{ b64_json: B64 }],
  output_format: "png",
  usage: { input_tokens: 12, output_tokens: 272, total_tokens: 284 },
  copilot_usage: { total_nano_aiu: 0.7 * AIU },
}

function model(id: string, type: string, endpoints: Array<string>): Model {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: "test",
    version: id,
    model_picker_enabled: true,
    supported_endpoints: endpoints,
    capabilities: {
      family: id,
      type,
      tokenizer: "o200k_base",
      object: "model_capabilities",
      limits: {
        max_prompt_tokens: 128_000,
        max_context_window_tokens: 400_000,
      },
      supports: {},
    },
  }
}

const app = new Hono()
app.use(traceIdMiddleware)
app.use(async (_c, next) => {
  const store = requestContext.getStore()
  if (store) store.usage.apiKeyLabel = HELPER_LABEL
  await next()
})
app.route("/v1/messages", messageRoutes)
app.route("/token-usage", tokenUsageRoute)

interface MessagesCall {
  body: {
    tools?: Array<{ name: string }>
    messages: Array<{ role: string; content: unknown }>
  }
}

let messagesCalls: Array<MessagesCall>
let imageCalls: Array<{ path: string; body: Record<string, unknown> }>
let heldDuringImageCall: number | undefined
let gateway: TestGateway
let outDir: string

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

const callGenerate = (input: Record<string, unknown> = {}) =>
  message(
    [
      { type: "text", text: "Drawing it. " },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "generate_image",
        input: { prompt: "a red square", ...input },
      },
    ],
    "tool_use",
  )
const done = message([{ type: "text", text: "Done." }], "end_turn")

let replies: Array<Record<string, unknown>>

const post = () =>
  app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-test",
      max_tokens: 256,
      messages: [{ role: "user", content: "draw a red square" }],
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: { type: "object", properties: {} },
        },
      ],
    }),
  })

function setBudget(budget: BudgetConfig): void {
  writeConfig({ ...getConfig(), budget })
}

const globalLimit = (amount: number): BudgetConfig => ({
  limits: [
    {
      id: "all",
      label: "Everything",
      scope: { kind: "global" },
      limit: amount,
      limitReset: "daily",
      action: "block",
    },
  ],
})

async function globalSpend(): Promise<number> {
  const [sum] = await getNanoAiuSpend({ kind: "global" }, [
    { startMs: 0, endMs: null },
  ])
  return sum
}

/** The last tool_result the model was handed, as text. */
function lastToolResult(): { text: string; isError: boolean } {
  const last = messagesCalls.at(-1)?.body.messages.at(-1)
  const blocks = last?.content as Array<Record<string, unknown>>
  const result = blocks.find((block) => block.type === "tool_result")
  return {
    text: JSON.stringify(result?.content),
    isError: result?.is_error === true,
  }
}

beforeEach(async () => {
  consola.level = 1
  process.env[DB_PATH_ENV] = ":memory:"
  writeConfig({ modelMappings: [] })
  await closeUsageStore()
  __resetBudgetServiceForTests()
  __resetProviderWindowsForTests()
  state.accountType = "individual"
  state.copilotToken = "test-token"
  state.githubToken = "test-github-token"
  state.manualApprove = false
  state.verbose = false
  state.vsCodeVersion = "1.0.0"
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.lastRequestTimestamp = undefined
  state.models = {
    object: "list",
    data: [
      model("claude-test", "chat", ["/v1/messages"]),
      model(IMAGE_MODEL, "image", []),
    ],
  }
  messagesCalls = []
  imageCalls = []
  heldDuringImageCall = undefined
  replies = [callGenerate(), done]
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-tools-"))
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const text = typeof init?.body === "string" ? init.body : ""
    if (url.pathname.startsWith("/v1/images/")) {
      imageCalls.push({
        path: url.pathname,
        body: JSON.parse(text) as Record<string, unknown>,
      })
      heldDuringImageCall = getBudgetService().heldNanoAiu({
        kind: "global",
      })
      return Promise.resolve(Response.json(imagesReply))
    }
    messagesCalls.push({ body: JSON.parse(text) as MessagesCall["body"] })
    return Promise.resolve(
      Response.json(
        replies[Math.min(messagesCalls.length - 1, replies.length - 1)],
      ),
    )
  }) as unknown as typeof fetch
  gateway = await startTestGateway([images], ["images"])
  await gateway.gateway.updateConfig("images", { outputDir: outDir })
})

afterEach(async () => {
  consola.level = 3
  await gateway.dispose()
  __resetBudgetServiceForTests()
  await closeUsageStore()
  __resetProviderWindowsForTests()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  Object.assign(state, originalState)
  writeConfig(originalConfig)
  fs.rmSync(outDir, { recursive: true, force: true })
})

const approve = () => gateway.gateway.runAction("images", APPROVE_ACTION)

describe("generate_image in the /v1/messages loop", () => {
  test("generates, saves a file, and hands the model its path (not the image)", async () => {
    await approve()

    const response = await post()
    const json = (await response.json()) as {
      content: Array<{ type: string; text?: string }>
      stop_reason: string
    }

    expect(response.status).toBe(200)
    // Both tools are offered after the client's own, hidden from the client.
    expect(messagesCalls[0].body.tools?.map((tool) => tool.name)).toEqual([
      "Read",
      "edit_image",
      "generate_image",
    ])
    expect(json.content).toEqual([
      { type: "text", text: "Drawing it. " },
      { type: "text", text: "Done." },
    ])
    // The image call carried the tool's defaults.
    expect(imageCalls).toHaveLength(1)
    expect(imageCalls[0].path).toBe("/v1/images/generations")
    expect(imageCalls[0].body).toMatchObject({
      model: IMAGE_MODEL,
      prompt: "a red square",
      size: "1024x1024",
      quality: "low",
      n: 1,
    })
    expect(imageCalls[0].body).not.toHaveProperty("stream")
    // One file in the output folder, and its path is what the model read.
    const files = fs.readdirSync(outDir)
    expect(files).toHaveLength(1)
    const file = path.join(outDir, files[0])
    expect(fs.readFileSync(file)).toEqual(PNG)
    const result = lastToolResult()
    expect(result.isError).toBe(false)
    expect(result.text).toContain(file)
    expect(result.text).not.toContain(B64)
    expect(JSON.stringify(messagesCalls)).not.toContain(B64)
  })

  test("holds the real estimate while it runs and books what the provider billed", async () => {
    await approve()
    setBudget(globalLimit(10 * AIU))

    await post()

    // A low-quality generation is estimated at 0.6 credits, not 0.
    expect(heldDuringImageCall).toBe(0.6 * AIU)
    expect(getBudgetService().heldNanoAiu({ kind: "global" })).toBe(0)
    expect(await globalSpend()).toBe(0.7 * AIU)
    const rows = (await (
      await app.request("/token-usage/events?period=day&page=1&page_size=10")
    ).json()) as { items: Array<Record<string, unknown>> }
    const imageRow = rows.items.find((row) => row.endpoint === "images")
    expect(imageRow).toMatchObject({
      model: IMAGE_MODEL,
      provider_name: "copilot",
      source: "copilot",
      output_tokens: 272,
    })
    expect(rows.items.filter((row) => row.endpoint === "images")).toHaveLength(
      1,
    )
  })

  test("a quality and count raise the estimate", async () => {
    await approve()
    setBudget(globalLimit(10 * AIU))
    replies = [callGenerate({ quality: "medium", n: 2 }), done]

    await post()

    // 0.6 low x 4 (medium) x 2 images.
    expect(heldDuringImageCall).toBe(4.8 * AIU)
  })

  test("a limit with no room for the estimate refuses it as the tool's result", async () => {
    await approve()
    // Nothing is spent, but 0.6 credits would not fit under 0.5.
    setBudget(globalLimit(0.5 * AIU))

    const response = await post()

    expect(response.status).toBe(200)
    expect(imageCalls).toEqual([])
    expect(fs.readdirSync(outDir)).toEqual([])
    const result = lastToolResult()
    expect(result.isError).toBe(true)
    expect(result.text).toContain("Not run:")
    expect(result.text).toContain("Don't retry this tool")
    expect(await globalSpend()).toBe(0)
    expect(getBudgetService().heldNanoAiu({ kind: "global" })).toBe(0)
  })

  test("a limit on the images plugin that is spent refuses it too", async () => {
    await approve()
    setBudget({
      limits: [
        {
          id: "images",
          label: "Images",
          scope: { kind: "plugin", id: "images" },
          limit: 0,
          limitReset: "daily",
          action: "block",
        },
      ],
    })

    await post()

    expect(imageCalls).toEqual([])
    expect(lastToolResult().isError).toBe(true)
    expect(lastToolResult().text).toContain("Not run:")
  })

  test("the first call waits for approval; after it, the same request works", async () => {
    const first = await post()

    expect(first.status).toBe(200)
    expect(imageCalls).toEqual([])
    const waiting = lastToolResult()
    expect(waiting.isError).toBe(true)
    expect(waiting.text).toContain("have not approved")
    expect(
      gateway.gateway.get("images")?.status?.attention?.actions[0].id,
    ).toBe(APPROVE_ACTION)

    await approve()
    messagesCalls = []
    replies = [callGenerate(), done]
    await post()

    expect(imageCalls).toHaveLength(1)
    expect(lastToolResult().isError).toBe(false)
    expect(fs.readdirSync(outDir)).toHaveLength(1)
  })

  test("an input the tool refuses is an error result and releases the hold", async () => {
    await approve()
    setBudget(globalLimit(10 * AIU))
    replies = [callGenerate({ n: 9 }), done]

    await post()

    // The input is refused before the provider is called.
    expect(imageCalls).toEqual([])
    const result = lastToolResult()
    expect(result.isError).toBe(true)
    expect(result.text).toContain("n must be a whole number from 1 to 4")
    expect(getBudgetService().heldNanoAiu({ kind: "global" })).toBe(0)
    expect(await globalSpend()).toBe(0)
  })
})
