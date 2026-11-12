/* eslint-disable max-lines-per-function -- provider integration scenarios share one stateful fixture */
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
import {
  ProviderInvocationJournal,
  providerInvocationJournal,
} from "~/lib/plugins/provider-broker"
import { createCopilotProviderBroker } from "~/lib/plugins/providers/copilot"
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
  providerInvocationJournal.reset()
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

const invocation = (id: string, model = "gpt-image-2.5-flare") => ({
  invocationId: id,
  providerCallId: `${id}-call`,
  sequence: 1,
  operation: "images.generations" as const,
  model,
})

const journalCall = (
  invocationId: string,
  providerCallId: string,
  sequence: number,
) => ({
  invocationId,
  providerCallId,
  sequence,
  operation: "images.generations" as const,
  model: "image-model",
})

describe("provider invocation journal", () => {
  test("enforces monotonic calls, identity reuse, and idempotent acknowledgments", () => {
    const journal = new ProviderInvocationJournal()
    const first = journalCall("invocation", "call-1", 1)
    journal.begin(first, "copilot")
    journal.observeSuccess(first, "copilot")
    journal.acknowledge("invocation", "call-1", 1)
    journal.acknowledge("invocation", "call-1", 1)
    expect(() => journal.acknowledge("invocation", "call-1", 2)).toThrow(
      "does not match",
    )
    expect(() =>
      journal.begin(journalCall("invocation", "call-1", 2), "copilot"),
    ).toThrow("reused")
    expect(() =>
      journal.begin(journalCall("invocation", "call-2", 1), "copilot"),
    ).toThrow("monotonically")
  })

  test("bounds live invocations and total calls even after acknowledgment", () => {
    const journal = new ProviderInvocationJournal({
      maxInvocations: 1,
      maxCallsPerInvocation: 2,
    })
    for (const sequence of [1, 2]) {
      const current = journalCall("invocation", `call-${sequence}`, sequence)
      journal.begin(current, "copilot")
      journal.observeSuccess(current, "copilot")
      journal.acknowledge("invocation", current.providerCallId, sequence)
    }
    expect(() =>
      journal.begin(journalCall("invocation", "call-3", 3), "copilot"),
    ).toThrow("too many provider calls")
    expect(() =>
      journal.begin(journalCall("other", "call-1", 1), "copilot"),
    ).toThrow("journal is full")
  })

  test("recovery is ordered and tombstones ambiguous invocation ids", () => {
    const journal = new ProviderInvocationJournal()
    const second = journalCall("invocation", "call-2", 2)
    const first = journalCall("invocation", "call-1", 1)
    journal.begin(first, "copilot")
    journal.begin(second, "copilot")
    journal.observeSuccess(second, "copilot", {
      unit: "nano_aiu",
      amount: 2,
      estimated: false,
    })

    expect(
      journal.recover().map((entry) => ({
        id: entry.invocation.providerCallId,
        outcome: entry.outcome,
      })),
    ).toEqual([
      { id: "call-1", outcome: "pending" },
      { id: "call-2", outcome: "success" },
    ])
    expect(() => journal.begin(first, "copilot")).toThrow("cannot be replayed")
  })
})

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
      {
        errorMessage: "Failed to create image",
        invocation: invocation("post-json"),
      },
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

  test("journals one ordered billable observation per provider call id", async () => {
    const { provider } = await startProvider(() =>
      Response.json({ copilot_usage: { total_nano_aiu: 42 } }),
    )
    const invocation = {
      invocationId: "invocation-1",
      providerCallId: "provider-call-1",
      sequence: 2,
      operation: "images.generations" as const,
      model: "gpt-image-2.5-flare",
    }

    await provider.postJson(
      "/v1/images/generations",
      { model: invocation.model, prompt: "x" },
      { errorMessage: "Failed to create image", invocation },
    )
    const replayError = await provider
      .postJson(
        "/v1/images/generations",
        { model: invocation.model, prompt: "x" },
        { errorMessage: "Failed to create image", invocation },
      )
      .catch((error: unknown) => error)
    expect(replayError).toBeInstanceOf(Error)
    expect((replayError as Error).message).toContain("cannot be replayed")

    expect(providerInvocationJournal.unacknowledged("invocation-1")).toEqual([
      {
        invocation,
        provider: "copilot",
        cost: { unit: "nano_aiu", amount: 42, estimated: false },
        outcome: "success",
      },
    ])
  })

  test("a refusal throws HTTPError carrying call.provider, endpoint and model", async () => {
    const { provider } = await startProvider(() => refusal())
    const error = await provider
      .postJson(
        "/v1/images/generations",
        { model: "gpt-6-luna-decisions", prompt: "x" },
        {
          errorMessage: "Failed to create image",
          invocation: invocation("refusal", "gpt-6-luna-decisions"),
        },
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
        {
          errorMessage: "Failed to create image",
          invocation: invocation("advice", "gpt-6-luna-decisions"),
        },
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

  test("fans one durably fenced source update out to every subscriber", async () => {
    let releaseFence!: () => void
    const fenced = new Promise<void>((resolve) => {
      releaseFence = resolve
    })
    const digests: Array<string> = []
    const broker = createCopilotProviderBroker({
      commitControlMutation: (digest) => {
        digests.push(digest)
        return fenced
      },
    })
    let first = 0
    let second = 0
    const stopFirst = broker.subscribe(() => {
      first += 1
    })
    const stopSecond = broker.subscribe(() => {
      second += 1
    })
    const before = broker.snapshot()

    setModels({ object: "list", data: CATALOG })
    await Promise.resolve()
    expect(broker.snapshot()).toEqual(before)
    expect(digests).toHaveLength(1)
    releaseFence()
    for (let attempt = 0; second === 0 && attempt < 100; attempt += 1)
      await Bun.sleep(1)

    expect(first).toBe(1)
    expect(second).toBe(1)
    expect(digests).toHaveLength(1)
    expect(broker.snapshot()).toMatchObject({
      revision: 1,
      models: [{ id: "gpt-6-luna-decisions" }, { id: "gpt-image-2.5-flare" }],
    })
    stopFirst()
    stopSecond()
  })

  test("model() reads the cached catalog and onCatalogChange follows it", async () => {
    const { provider } = await startProvider(() => Response.json({}))
    state.models = undefined
    expect(provider.model("gpt-image-2.5-flare")).toBeUndefined()

    let changes = 0
    const stop = provider.onCatalogChange(() => (changes += 1))
    setModels({ object: "list", data: CATALOG })
    for (let attempt = 0; changes === 0 && attempt < 100; attempt += 1)
      await Bun.sleep(1)
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
