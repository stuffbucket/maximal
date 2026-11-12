/**
 * The SystemOne plugin through a real host with a fake upstream provider:
 * what it serves, how it relays, what it reports, and that it leaves nothing
 * behind when turned off.
 */
import {
  capabilityServices,
  catalogModel,
  createFakeUpstream,
  createLifecycleHarness,
  type LifecycleHarness,
  rejection,
} from "@stuffbucket/maximal-plugin-host/testing"
import { OperationUnavailableError } from "@stuffbucket/maximal-plugin-sdk"
import { afterEach, describe, expect, test } from "bun:test"

import * as systemone from "../src/index"

const handles: Array<LifecycleHarness> = []
afterEach(async () => {
  for (const harness of handles.splice(0)) await harness.dispose()
})

async function start(options: Parameters<typeof createFakeUpstream>[0] = {}) {
  const fake = createFakeUpstream({
    models: [catalogModel("microsoft-decision-1")],
    ...options,
  })
  const harness = createLifecycleHarness({
    plugins: [systemone],
    extraServices: capabilityServices(fake),
  })
  handles.push(harness)
  await harness.enable("systemone")
  await harness.waitForStatus("systemone", () => true)
  return { fake, harness, operations: harness.gateway.operations() }
}

const request = (model: string, body: Record<string, unknown> = {}) => ({
  operation: "systemone" as const,
  model,
  body: { model, ...body },
  signal: new AbortController().signal,
  origin: { kind: "http" as const, client: "test" },
})

describe("systemone plugin", () => {
  test("serves microsoft-decision-1 on Copilot by default, and nothing else", async () => {
    const { operations } = await start()

    expect(operations.servedModels()).toEqual([
      {
        model: "microsoft-decision-1",
        provider: "copilot",
        upstreamModel: "microsoft-decision-1",
        operations: ["systemone"],
      },
    ])
    expect(operations.resolve("systemone", "gpt-x")).toBeUndefined()
    expect(
      operations.resolve("decisions", "microsoft-decision-1"),
    ).toBeUndefined()
  })

  test("relays the body to /v1/systemone and the reply back, with plain usage", async () => {
    const reply = {
      model: "dev-microsoft-decision-1.1",
      answers: { is_done: { value: true } },
      usage: { input_tokens: 30, output_tokens: 4 },
    }
    const { fake, operations } = await start({ reply })
    const body = {
      state: "The task finished.",
      questions: { is_done: { type: "boolean", instructions: "Done?" } },
    }

    const result = await operations.dispatch(
      request("microsoft-decision-1", body),
    )

    expect(result.json).toEqual(reply)
    expect(result.usage).toEqual({ input_tokens: 30, output_tokens: 4 })
    expect(result.cost).toBeUndefined()
    expect(fake.calls[0].path).toBe("/v1/systemone")
    expect(fake.calls[0].body).toEqual({
      model: "microsoft-decision-1",
      ...body,
    })
    expect(fake.calls[0].options.errorMessage).toBe(
      "Failed to create SystemOne decisions",
    )
  })

  test("a namespaced id reaches the provider under its own model id", async () => {
    const { fake, operations } = await start()

    await operations.dispatch(request("copilot/microsoft-decision-1"))

    expect(fake.calls[0].body).toMatchObject({ model: "microsoft-decision-1" })
  })

  test("says when the model isn't on the account's plan", async () => {
    const { fake, harness } = await start()
    const status = () => harness.snapshot("systemone").status

    expect(status()?.code).toBe("ready")

    fake.setModels([])
    expect(status()?.code).toBe("model-not-offered")
    expect(status()?.summary).toContain("microsoft-decision-1")
  })

  test("turning it off withdraws the model and the catalog subscription", async () => {
    const { fake, harness, operations } = await start()
    expect(fake.listenerCount).toBe(1)

    await harness.disable("systemone")

    expect(operations.servedModels()).toEqual([])
    expect(fake.listenerCount).toBe(0)
    expect(
      await rejection(operations.dispatch(request("microsoft-decision-1"))),
    ).toBeInstanceOf(OperationUnavailableError)
  })
})
