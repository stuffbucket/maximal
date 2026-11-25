/**
 * The images plugin through a real host with a fake upstream provider: both
 * operations, JSON and multipart edits, usage and cost, status, and that it
 * leaves nothing behind when turned off.
 */
import {
  capabilityServices,
  catalogModel,
  createFakeUpstream,
  createLifecycleHarness,
  type LifecycleHarness,
  rejection,
} from "@stuffbucket/maximal-plugin-host/testing"
import {
  type ModelOperation,
  OperationUnavailableError,
} from "@stuffbucket/maximal-plugin-sdk"
import { afterEach, describe, expect, test } from "bun:test"

import * as images from "../src/index"

const MODEL = "gpt-image-2.5-flare"

const handles: Array<LifecycleHarness> = []
afterEach(async () => {
  for (const harness of handles.splice(0)) await harness.dispose()
})

async function start(options: Parameters<typeof createFakeUpstream>[0] = {}) {
  const fake = createFakeUpstream({
    models: [catalogModel(MODEL, "image")],
    ...options,
  })
  const harness = createLifecycleHarness({
    plugins: [images],
    extraServices: capabilityServices(fake),
  })
  handles.push(harness)
  await harness.enable("images")
  await harness.waitForStatus("images", () => true)
  return { fake, harness, operations: harness.gateway.operations() }
}

const request = (
  operation: ModelOperation,
  model: string,
  body: Record<string, unknown> | FormData,
) => ({
  operation,
  model,
  body,
  signal: new AbortController().signal,
  origin: { kind: "http" as const, client: "test" },
  invocationId: "test-invocation",
  providerCallId: "test-provider-call",
  sequence: 1,
})

const imagesReply = {
  created: 1_700_000_000,
  data: [{ b64_json: "aW1hZ2U=" }],
  usage: {
    input_tokens: 12,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens: 272,
    total_tokens: 284,
  },
  copilot_usage: { total_nano_aiu: 5_000_000 },
}

describe("images plugin", () => {
  test("serves gpt-image-2.5-flare for generations and edits, and nothing else", async () => {
    const { operations } = await start()

    expect(operations.servedModels()).toEqual([
      {
        model: MODEL,
        provider: "copilot",
        upstreamModel: MODEL,
        operations: ["images.generations", "images.edits"],
      },
    ])
    expect(operations.resolve("images.generations", MODEL)).toBeDefined()
    expect(operations.resolve("images.edits", `copilot/${MODEL}`)).toBeDefined()
    expect(operations.resolve("images.generations", "gpt-x")).toBeUndefined()
    expect(operations.resolve("decisions", MODEL)).toBeUndefined()
  })

  test("generations: relays the body to /v1/images/generations with usage and cost", async () => {
    const { fake, operations } = await start({
      reply: imagesReply,
      cost: () => 5_000_000,
    })
    const body = { model: MODEL, prompt: "a red square", quality: "low" }

    const result = await operations.dispatch(
      request("images.generations", MODEL, body),
    )

    expect(result.json).toEqual(imagesReply)
    expect(result.usage).toEqual({
      input_tokens: 10,
      output_tokens: 272,
      cache_read_input_tokens: 2,
      total_tokens: 284,
    })
    expect(result.cost).toEqual({
      unit: "nano_aiu",
      amount: 5_000_000,
      estimated: false,
    })
    expect(fake.calls[0].path).toBe("/v1/images/generations")
    expect(fake.calls[0].body).toBe(body)
    expect(fake.calls[0].options.errorMessage).toBe("Failed to generate images")
  })

  test("edits: a JSON edit goes to /v1/images/edits as JSON", async () => {
    const { fake, operations } = await start({ reply: imagesReply })
    const body = {
      model: MODEL,
      prompt: "make it blue",
      images: [{ image_url: "data:image/png;base64,AQID" }],
    }

    await operations.dispatch(request("images.edits", MODEL, body))

    expect(fake.calls[0].path).toBe("/v1/images/edits")
    expect(fake.calls[0].body).toBe(body)
    expect(fake.calls[0].options.errorMessage).toBe("Failed to edit images")
  })

  test("edits: a multipart form is relayed as a form, files intact", async () => {
    const { fake, operations } = await start({ reply: imagesReply })
    const form = new FormData()
    form.append("model", MODEL)
    form.append("prompt", "make it blue")
    form.append(
      "image[]",
      new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }),
    )

    await operations.dispatch(request("images.edits", MODEL, form))

    const sent = fake.calls[0].body
    expect(sent).toBe(form)
    expect((sent as FormData).getAll("image[]")).toHaveLength(1)
  })

  test("edits: a namespaced id rewrites the form's model without touching the client's form", async () => {
    const { fake, operations } = await start({ reply: imagesReply })
    const form = new FormData()
    form.append("model", `copilot/${MODEL}`)
    form.append("prompt", "make it blue")
    form.append(
      "image[]",
      new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }),
    )

    await operations.dispatch(request("images.edits", `copilot/${MODEL}`, form))

    const sent = fake.calls[0].body as FormData
    expect(sent).not.toBe(form)
    expect(sent.get("model")).toBe(MODEL)
    expect(sent.get("prompt")).toBe("make it blue")
    const file = sent.get("image[]") as File
    expect(file.name).toBe("a.png")
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([
      1, 2, 3,
    ])
    expect(form.get("model")).toBe(`copilot/${MODEL}`)
  })

  test("a provider failure propagates untouched", async () => {
    const { fake, operations } = await start()
    const failure = new Error("upstream said no")
    fake.enqueue(failure)

    expect(
      await rejection(
        operations.dispatch(request("images.generations", MODEL, {})),
      ),
    ).toBe(failure)
  })

  test("reports its status from the provider's sign-in and catalog", async () => {
    const { fake, harness } = await start()
    const code = () => harness.snapshot("images").status?.code

    expect(code()).toBe("ready")

    fake.setModels([])
    expect(code()).toBe("model-not-offered")

    fake.setAvailable(false)
    fake.setModels([])
    expect(code()).toBe("signin-needed")

    fake.setAvailable(true)
    fake.setModels([catalogModel(MODEL, "image")])
    expect(code()).toBe("ready")
  })

  test("turning it off withdraws both operations and the catalog subscription", async () => {
    const { fake, harness, operations } = await start()
    expect(fake.listenerCount).toBe(1)

    await harness.disable("images")

    expect(operations.servedModels()).toEqual([])
    expect(fake.listenerCount).toBe(0)
    expect(
      await rejection(operations.dispatch(request("images.edits", MODEL, {}))),
    ).toBeInstanceOf(OperationUnavailableError)
  })
})
