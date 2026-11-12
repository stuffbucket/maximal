import {
  capabilityServices,
  catalogModel,
  createFakeUpstream,
  createLifecycleHarness,
  type LifecycleHarness,
  rejection,
} from "@stuffbucket/maximal-plugin-host/testing"
/**
 * The decisions plugin through a real host with a fake upstream provider:
 * what it serves, how it relays, what it reports, and that it leaves nothing
 * behind when turned off.
 */
import { OperationUnavailableError } from "@stuffbucket/maximal-plugin-sdk"
import { afterEach, describe, expect, test } from "bun:test"

import * as decisions from "../src/index"

const handles: Array<LifecycleHarness> = []
afterEach(async () => {
  for (const harness of handles.splice(0)) await harness.dispose()
})

async function start(options: Parameters<typeof createFakeUpstream>[0] = {}) {
  const fake = createFakeUpstream({
    models: [catalogModel("gpt-6-luna-decisions")],
    ...options,
  })
  const harness = createLifecycleHarness({
    plugins: [decisions],
    extraServices: capabilityServices(fake),
  })
  handles.push(harness)
  await harness.enable("decisions")
  await harness.waitForStatus("decisions", () => true)
  return { fake, harness, operations: harness.gateway.operations() }
}

const request = (model: string, body: Record<string, unknown> = {}) => ({
  operation: "decisions" as const,
  model,
  body: { model, ...body },
  signal: new AbortController().signal,
  origin: { kind: "http" as const, client: "test" },
})

describe("decisions plugin", () => {
  test("serves gpt-6-luna-decisions on Copilot by default, and nothing else", async () => {
    const { operations } = await start()

    expect(operations.servedModels()).toEqual([
      {
        model: "gpt-6-luna-decisions",
        provider: "copilot",
        upstreamModel: "gpt-6-luna-decisions",
        operations: ["decisions"],
      },
    ])
    expect(
      operations.resolve("decisions", "copilot/gpt-6-luna-decisions"),
    ).toBeDefined()
    expect(operations.resolve("decisions", "gpt-x")).toBeUndefined()
    expect(
      operations.resolve("systemone", "gpt-6-luna-decisions"),
    ).toBeUndefined()
  })

  test("relays the body unchanged to /v1/decisions and the reply back, with Responses-shaped usage", async () => {
    const reply = {
      answers: [{ name: "q1", answer: "yes" }],
      usage: {
        input_tokens: 40,
        input_tokens_details: { cached_tokens: 8 },
        output_tokens: 5,
        total_tokens: 45,
      },
      copilot_usage: { total_nano_aiu: 123 },
    }
    const { fake, operations } = await start({
      reply,
      cost: () => 123,
    })
    const body = { questions: [{ name: "q1" }], input: "Is the sky blue?" }

    const result = await operations.dispatch(
      request("gpt-6-luna-decisions", body),
    )

    expect(result.json).toEqual(reply)
    expect(result.usage).toEqual({
      input_tokens: 32,
      output_tokens: 5,
      cache_read_input_tokens: 8,
      total_tokens: 45,
    })
    expect(result.cost).toEqual({
      unit: "nano_aiu",
      amount: 123,
      estimated: false,
    })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].path).toBe("/v1/decisions")
    expect(fake.calls[0].body).toEqual({
      model: "gpt-6-luna-decisions",
      ...body,
    })
    expect(fake.calls[0].options.errorMessage).toBe(
      "Failed to create decisions",
    )
  })

  test("a namespaced id reaches the provider under its own model id", async () => {
    const { fake, operations } = await start()

    await operations.dispatch(request("copilot/gpt-6-luna-decisions"))

    expect(fake.calls[0].body).toMatchObject({ model: "gpt-6-luna-decisions" })
  })

  test("a provider failure propagates untouched", async () => {
    const { fake, operations } = await start()
    const failure = new Error("upstream said no")
    fake.enqueue(failure)

    expect(
      await rejection(operations.dispatch(request("gpt-6-luna-decisions"))),
    ).toBe(failure)
  })

  test("a binding to a provider nobody registered is unavailable, not a server fault", async () => {
    const { harness, operations } = await start()
    await harness.setConfig("decisions", {
      bindings: [{ model: "m", provider: "nowhere", upstreamModel: "m" }],
    })
    await harness.flush()

    expect(await rejection(operations.dispatch(request("m")))).toBeInstanceOf(
      OperationUnavailableError,
    )
    expect(harness.snapshot("decisions").status?.code).toBe("provider-missing")
  })

  test("reports its status from the provider's sign-in and catalog", async () => {
    const { fake, harness } = await start()
    const code = () => harness.snapshot("decisions").status?.code

    expect(code()).toBe("ready")

    fake.setModels([])
    expect(code()).toBe("model-not-offered")

    fake.setAvailable(false)
    fake.setModels([])
    expect(code()).toBe("signin-needed")

    fake.setAvailable(true)
    fake.setModels([catalogModel("gpt-6-luna-decisions")])
    expect(code()).toBe("ready")
  })

  test("turning it off withdraws the model and the catalog subscription", async () => {
    const { fake, harness, operations } = await start()
    expect(fake.listenerCount).toBe(1)

    await harness.disable("decisions")

    expect(operations.servedModels()).toEqual([])
    expect(
      operations.resolve("decisions", "gpt-6-luna-decisions"),
    ).toBeUndefined()
    expect(fake.listenerCount).toBe(0)
    expect(
      await rejection(operations.dispatch(request("gpt-6-luna-decisions"))),
    ).toBeInstanceOf(OperationUnavailableError)
  })
})
