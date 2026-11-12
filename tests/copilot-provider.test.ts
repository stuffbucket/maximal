/**
 * The Copilot upstream provider, reached the way a plugin reaches it
 * (`ctx.providers.get("copilot")`) through a gateway composed by
 * `composePluginGateway`. The transport is an injected fake `sendRequest`; the
 * model catalog is the app `state`, restored after each test.
 */

import type { Context } from "@stuffbucket/maximal-plugin-sdk"
import type { UpstreamProvider } from "@stuffbucket/maximal-plugin-sdk/gateway"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Model } from "~/services/copilot/get-models"

import { HTTPError } from "~/lib/errors/http-errors"
import { proxyErrorHandler } from "~/lib/errors/proxy-errors"
import { composePluginGateway } from "~/lib/plugins/compose"
import { setModels, state } from "~/lib/runtime-state/state"

import { definePlugin } from "./helpers/plugins"

const originalState = {
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  lastUpstreamRejection: state.lastUpstreamRejection,
  models: state.models,
}

beforeEach(() => {
  state.copilotToken = "test-token"
  state.githubToken = "test-github-token"
})

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  Object.assign(state, originalState)
})

/** A hidden catalog entry serving `endpoints`. */
function catalogModel(
  id: string,
  type: string,
  endpoints: Array<string>,
): Model {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: "openai",
    version: id,
    model_picker_enabled: false,
    supported_endpoints: endpoints,
    capabilities: {
      family: id,
      type,
      tokenizer: "o200k_base",
      object: "model_capabilities",
      limits: {},
      supports: {},
    },
  }
}

const CATALOG: Array<Model> = [
  catalogModel("gpt-6-luna-decisions", "decisions", ["/v1/decisions"]),
  catalogModel("gpt-image-2.5-flare", "image", [
    "/v1/images/generations",
    "/v1/images/edits",
  ]),
]

interface Sent {
  url: string
  init: RequestInit
}

/** Start a gateway whose only plugin captures the `copilot` provider. */
async function startProvider(
  reply: () => Response,
): Promise<{ provider: UpstreamProvider; sent: Array<Sent> }> {
  const sent: Array<Sent> = []
  let captured: UpstreamProvider | undefined
  const probe = {
    ...definePlugin(
      "probe",
      (ctx: Context) => {
        captured = ctx.providers.get("copilot")
      },
      { kind: "model" },
    ),
    inject: ["providers"],
  }
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-prov-"))
  const gateway = composePluginGateway({
    plugins: [probe],
    storageRoot,
    copilot: {
      sendRequest: (url, init) => {
        sent.push({ url, init: init ?? {} })
        return Promise.resolve(reply())
      },
    },
  })
  cleanups.push(async () => {
    await gateway.dispose()
    fs.rmSync(storageRoot, { recursive: true, force: true })
  })
  await gateway.reconcile({ probe: { enabled: true } })
  expect(gateway.get("probe")?.lifecycle).toBe("active")
  if (!captured) throw new Error("the plugin did not get the copilot provider")
  return { provider: captured, sent }
}

const refusal = (message = "Model is not supported for this request.") =>
  new Response(
    JSON.stringify({
      error: { message, code: "model_not_supported", param: "model" },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  )

describe("the copilot provider", () => {
  test("is registered at host start and reports itself", async () => {
    const { provider } = await startProvider(() => Response.json({}))
    expect(provider.id).toBe("copilot")
    expect(provider.displayName).toBe("GitHub Copilot")
    expect(provider.available()).toBe(true)
    state.copilotToken = undefined
    expect(provider.available()).toBe(false)
  })

  test("postJson sends the body to the Copilot path and returns the parsed reply", async () => {
    const { provider, sent } = await startProvider(() =>
      Response.json({ data: [{ b64_json: "AAAA" }] }),
    )
    const result = await provider.postJson<{ data: Array<unknown> }>(
      "/v1/images/generations",
      { model: "gpt-image-2.5-flare", prompt: "x" },
      { errorMessage: "Failed to create image" },
    )
    expect(result).toEqual({ data: [{ b64_json: "AAAA" }] })
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toEndWith("/v1/images/generations")
    expect(sent[0].init.method).toBe("POST")
    expect(JSON.parse(sent[0].init.body as string)).toEqual({
      model: "gpt-image-2.5-flare",
      prompt: "x",
    })
  })

  test("a refusal throws HTTPError carrying call.provider, endpoint and model", async () => {
    const { provider } = await startProvider(() => refusal())
    const error = await provider
      .postJson(
        "/v1/images/generations",
        { model: "gpt-6-luna-decisions", prompt: "x" },
        { errorMessage: "Failed to create image" },
      )
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HTTPError)
    expect((error as HTTPError).call).toEqual({
      provider: "copilot",
      endpoint: "/v1/images/generations",
      model: "gpt-6-luna-decisions",
    })
  })

  test("the refused call reaches the endpoint advice, through the error handler and the provider's adviseError", async () => {
    setModels({ object: "list", data: CATALOG })
    const { provider } = await startProvider(() => refusal())
    const app = new Hono()
    app.onError(proxyErrorHandler("openai"))
    app.post("/", async (c) => {
      await provider.postJson(
        "/v1/images/generations",
        await c.req.json<Record<string, unknown>>(),
        { errorMessage: "Failed to create image" },
      )
      return c.json({})
    })

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-luna-decisions", prompt: "x" }),
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { message: string } }
    const advice =
      "`gpt-6-luna-decisions` doesn't support `/v1/images/generations` "
      + "(it serves `/v1/decisions`).\n\n"
      + "Models that do: `gpt-image-2.5-flare`."
    expect(body.error.message).toStartWith(advice)
    expect(body.error.message).not.toContain("on your plan")

    // The provider's own advice agrees with the rewrite.
    const direct = provider.adviseError?.({
      status: 400,
      text: JSON.stringify({
        error: {
          message: "Model is not supported for this request.",
          code: "model_not_supported",
        },
      }),
      call: {
        provider: "copilot",
        endpoint: "/v1/images/generations",
        model: "gpt-6-luna-decisions",
      },
    })
    expect(direct).toStartWith(advice)
    expect(
      provider.adviseError?.({ status: 500, text: "boom", call: undefined }),
    ).toBeUndefined()
  })

  test("model() reads the cached catalog and onCatalogChange follows it", async () => {
    const { provider } = await startProvider(() => Response.json({}))
    state.models = undefined
    expect(provider.model("gpt-image-2.5-flare")).toBeUndefined()

    let changes = 0
    const stop = provider.onCatalogChange(() => (changes += 1))
    setModels({ object: "list", data: CATALOG })
    expect(changes).toBe(1)
    expect(provider.model("gpt-image-2.5-flare")).toEqual({
      id: "gpt-image-2.5-flare",
      type: "image",
      endpoints: ["/v1/images/generations", "/v1/images/edits"],
      preview: false,
    })
    expect(provider.model("nope")).toBeUndefined()

    stop()
    setModels({ object: "list", data: [] })
    expect(changes).toBe(1)
  })

  test("cost reads Copilot's total_nano_aiu and is undefined without it", async () => {
    const { provider } = await startProvider(() => Response.json({}))
    const request = { operation: "images.generations", model: "m" }
    expect(
      provider.cost({ copilot_usage: { total_nano_aiu: 1234 } }, request),
    ).toEqual({ unit: "nano_aiu", amount: 1234, estimated: false })
    expect(provider.cost({}, request)).toBeUndefined()
    expect(
      provider.cost({ copilot_usage: { total_nano_aiu: "x" } }, request),
    ).toBeUndefined()
  })
})
