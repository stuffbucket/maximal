/**
 * The `decide` server tool through a real host with a fake upstream: when it
 * is offered, what it sends, how it answers and fails.
 */
import type { ServerToolCall } from "@stuffbucket/maximal-plugin-sdk"

import {
  capabilityServices,
  catalogModel,
  createFakeUpstream,
  createLifecycleHarness,
  type LifecycleHarness,
} from "@stuffbucket/maximal-plugin-host/testing"
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
  return { fake, harness }
}

const toolNames = (harness: LifecycleHarness) =>
  harness.gateway.serverTools().map((tool) => `${tool.pluginId}/${tool.name}`)

let invocationCount = 0
const call = (): ServerToolCall => {
  const invocationId = `test-invocation-${++invocationCount}`
  let sequence = 0
  return {
    signal: new AbortController().signal,
    model: "claude-test",
    client: "claude-code",
    invocationId,
    nextProviderCall: (operation, model) => ({
      invocationId,
      providerCallId: `${invocationId}-call-${sequence + 1}`,
      sequence: ++sequence,
      operation,
      model,
    }),
  }
}

const run = (harness: LifecycleHarness, input: Record<string, unknown>) =>
  harness.gateway.callServerTool("decisions", "decide", input, call())

const questions = [
  { type: "predicate", name: "flaky", instructions: "Is the test flaky?" },
  {
    type: "choice",
    name: "owner",
    instructions: "Who owns it?",
    choices: [{ value: "web" }, { value: "api" }],
  },
  {
    type: "score",
    name: "risk",
    instructions: "How risky?",
    levels: [{ label: "Low" }, { label: "High" }],
  },
]

const reply = {
  model: "gpt-6-luna",
  answers: [
    { type: "predicate", name: "flaky", probability: 0.9712 },
    {
      type: "choice",
      name: "owner",
      choice: "api",
      probabilities: [
        { value: "web", probability: 0.1 },
        { value: "api", probability: 0.9 },
      ],
      confidence: 0.88,
    },
    {
      type: "score",
      name: "risk",
      score: 0.06,
      probabilities: [
        { value: 0, label: "Low", probability: 0.94 },
        { value: 1, label: "High", probability: 0.06 },
      ],
      confidence: 0.9,
    },
    { type: "refusal", name: "other" },
  ],
  usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
}

describe("decide server tool", () => {
  test("is a hidden always tool offered to Claude Code, with a name-required schema", async () => {
    const { harness } = await start()

    expect(harness.gateway.serverTools()).toHaveLength(1)
    expect(harness.gateway.serverTools()[0]).toMatchObject({
      pluginId: "decisions",
      name: "decide",
      render: "hidden",
      offer: "always",
      clients: ["claude-code"],
    })
    expect(harness.gateway.serverTools()[0].input_schema).toMatchObject({
      required: ["input", "questions"],
      properties: {
        questions: {
          items: { required: ["type", "name", "instructions"] },
        },
      },
    })
  })

  test("sends the questions to /v1/decisions under the provider's model and answers in compact text", async () => {
    const { fake, harness } = await start({ reply })

    const result = await run(harness, { input: "CI log...", questions })

    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([
      {
        type: "text",
        text: [
          "flaky: predicate, probability 0.97",
          'owner: choice "api", confidence 0.88 (web 0.1, api 0.9)',
          "risk: score 0.06 (0 = first level), confidence 0.9 (Low 0.94, High 0.06)",
          "other: refused",
        ].join("\n"),
      },
    ])
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].path).toBe("/v1/decisions")
    expect(fake.calls[0].body).toEqual({
      model: "gpt-6-luna-decisions",
      input: "CI log...",
      questions,
    })
  })

  test("refuses input the model can't accept without calling upstream", async () => {
    const { fake, harness } = await start()

    for (const bad of [
      { questions },
      { input: "x", questions: [] },
      { input: "x", questions: [{ type: "predicate", instructions: "?" }] },
    ]) {
      const result = await run(harness, bad)
      expect(result.isError).toBe(true)
    }
    expect(fake.calls).toHaveLength(0)
  })

  test("an upstream failure is an error result, not a throw", async () => {
    const { fake, harness } = await start()
    fake.enqueue(new Error("Bad Request"))

    const result = await run(harness, { input: "x", questions })

    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({
      text: "Failed to create decisions: Bad Request",
    })
  })

  test("a reply with no answers is an error result", async () => {
    const { harness } = await start({ reply: { answers: [] } })

    expect((await run(harness, { input: "x", questions })).isError).toBe(true)
  })

  test("is registered only while the model is offered and the provider signed in", async () => {
    const { fake, harness } = await start()
    expect(toolNames(harness)).toEqual(["decisions/decide"])

    fake.setModels([])
    expect(toolNames(harness)).toEqual([])

    fake.setModels([catalogModel("gpt-6-luna-decisions")])
    expect(toolNames(harness)).toEqual(["decisions/decide"])

    fake.setAvailable(false)
    fake.setModels([catalogModel("gpt-6-luna-decisions")])
    expect(toolNames(harness)).toEqual([])
  })

  test("turning the plugin off withdraws the tool", async () => {
    const { harness } = await start()

    await harness.disable("decisions")

    expect(toolNames(harness)).toEqual([])
  })

  test("`tools.decide: false` keeps it out", async () => {
    const { harness } = await start()

    await harness.setConfig("decisions", { tools: { decide: false } })
    await harness.flush()

    expect(toolNames(harness)).toEqual([])
  })

  test("the description is fixed: no live state, identical across runs and configs", async () => {
    const first = await start()
    const description = first.harness.gateway.serverTools()[0].description
    const second = await start({
      models: [catalogModel("gpt-6-luna-decisions")],
    })
    await second.harness.setConfig("decisions", {
      bindings: [
        {
          model: "m",
          provider: "copilot",
          upstreamModel: "gpt-6-luna-decisions",
        },
      ],
    })
    await second.harness.flush()

    expect(second.harness.gateway.serverTools()[0].description).toBe(
      description,
    )
    expect(description).not.toMatch(/gpt-6|\d{4}-\d{2}|copilot/i)
  })
})
