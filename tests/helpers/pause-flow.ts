/**
 * What the pause flow tests share: the budget routes, a chat route like the
 * real ones (the budget gate, then a reply) behind `withPause`, and readers
 * for what a held request is answered with.
 */

import type { Context } from "hono"

import { afterAll, afterEach, beforeEach } from "bun:test"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import { withPause } from "~/lib/budget/pause-hold"
import { __resetProviderWindowsForTests } from "~/lib/budget/provider-windows"
import {
  __resetBudgetServiceForTests,
  admitChat,
  getPauseGate,
} from "~/lib/budget/runtime"
import { writeConfig } from "~/lib/config/config"
import { BudgetStatusResponse } from "~/lib/config/settings-types"
import { proxyErrorHandler } from "~/lib/errors/proxy-errors"
import { traceIdMiddleware } from "~/lib/http/trace"
import { takePluginNotices } from "~/lib/plugins/notices"
import { closeUsageStore, recordTokenUsageEvent } from "~/lib/token-usage"
import { budgetRoutes } from "~/routes/settings/budget"
import { pluginsRoutes } from "~/routes/settings/plugins"

import { AIU } from "./budget-service-harness"

const DB_ENV = "COPILOT_API_SQLITE_DB_PATH"
export const app = new Hono()
  .route("/budget", budgetRoutes)
  .route("/plugins", pluginsRoutes)

export function send(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

export async function status(): Promise<BudgetStatusResponse> {
  return BudgetStatusResponse.parse(await (await send("GET", "/budget")).json())
}

export function putRule(
  extra: Record<string, unknown> = {},
  id = "agents",
): Promise<Response> {
  return send("PUT", `/budget/limits/${id}`, {
    label: "Agents",
    scope: { kind: "global" },
    limit: AIU,
    limit_reset: "daily",
    action: "pause",
    ...extra,
  })
}

export function spend(nanoAiu: number): void {
  recordTokenUsageEvent({
    endpoint: "messages",
    model: "gpt-test",
    source: "copilot",
    input_tokens: 1,
    total_nano_aiu: nanoAiu,
  })
}

async function chatHandler(c: Context): Promise<Response> {
  const payload = await c.req.json<{ stream?: boolean }>()
  await admitChat("messages", {})
  if (payload.stream === true) {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: "message_start",
        data: '{"type":"message_start"}',
      })
      await stream.writeSSE({
        event: "message_stop",
        data: '{"type":"message_stop"}',
      })
    })
  }
  return c.json({ ok: true })
}

/** A chat route like the real ones: the budget gate, then a reply. */
export function chatApp(
  wire: "anthropic" | "openai",
  options: { pingMs?: number } = {},
): Hono {
  const handler = chatHandler
  const onError = proxyErrorHandler(wire)
  const route = new Hono()
  route.onError(onError)
  route.use(traceIdMiddleware)
  route.post(
    "/",
    withPause({
      wire,
      operation: "messages",
      handler,
      onError,
      ...(options.pingMs === undefined ? {} : { pingMs: options.pingMs }),
    }),
  )
  return route
}

export const post = async (
  route: Hono,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> =>
  await route.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })

export async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await Bun.sleep(5)
  }
}

/** Everything a streaming response says, read as it arrives. */
export async function transcript(
  response: Response,
  until_?: (text: string) => boolean,
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const decoder = new TextDecoder()
  let text = ""
  while (true) {
    const read = await reader.read()
    if (read.done) return text
    const chunk: unknown = read.value
    if (chunk instanceof Uint8Array) text += decoder.decode(chunk)
    if (until_?.(text)) {
      await reader.cancel()
      return text
    }
  }
}

/** Register the per-test setup and teardown the flow tests share. */
export function useFlowHooks(): void {
  beforeEach(async () => {
    process.env[DB_ENV] = ":memory:"
    await closeUsageStore()
    __resetProviderWindowsForTests()
    __resetBudgetServiceForTests()
    writeConfig({})
    takePluginNotices()
  })

  afterEach(async () => {
    getPauseGate().cancel()
    __resetBudgetServiceForTests()
    await closeUsageStore()
    __resetProviderWindowsForTests()
    Reflect.deleteProperty(process.env, DB_ENV)
  })

  afterAll(() => {
    writeConfig({})
  })
}
