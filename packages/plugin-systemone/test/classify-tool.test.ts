import {
  capabilityServices,
  catalogModel,
  createFakeUpstream,
  createLifecycleHarness,
  type LifecycleHarness,
} from "@stuffbucket/maximal-plugin-host/testing"
/**
 * The `classify` server tool through a real host with a fake upstream: when
 * it is offered, what it sends, how it answers and fails.
 */
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
  return { fake, harness }
}

const toolNames = (harness: LifecycleHarness) =>
  harness.gateway.serverTools().map((tool) => `${tool.pluginId}/${tool.name}`)

const run = (harness: LifecycleHarness, input: Record<string, unknown>) =>
  harness.gateway.callServerTool("systemone", "classify", input, {
    signal: new AbortController().signal,
    model: "claude-test",
    client: "claude-code",
  })

const questions = {
  refund: { type: "noul", instructions: "Does it ask for a refund?" },
  team: {
    type: "choice",
    instructions: "Which team?",
    criteria: { billing: "Charges", engineering: "Bugs" },
  },
  severity: {
    type: "score",
    instructions: "How severe?",
    criteria: ["Minor", "Major"],
  },
}

const reply = {
  model: "dev-microsoft-decision-1.1",
  answers: {
    refund: { type: "noul", noul: 0.0001 },
    severity: {
      type: "score",
      score: 0.78,
      confidence: 0.71,
      legend: { "0": "Minor", "1": "Major" },
      probabilities: { "0": 0.22, "1": 0.78 },
    },
    team: {
      type: "choice",
      choice: "engineering",
      confidence: 0.99,
      probabilities: { billing: 0.003, engineering: 0.996 },
    },
  },
  usage: { input_tokens: 156, output_tokens: 4 },
}

describe("classify server tool", () => {
  test("is a hidden always tool offered to Claude Code", async () => {
    const { harness } = await start()

    expect(harness.gateway.serverTools()).toHaveLength(1)
    expect(harness.gateway.serverTools()[0]).toMatchObject({
      pluginId: "systemone",
      name: "classify",
      render: "hidden",
      offer: "always",
      clients: ["claude-code"],
    })
    expect(harness.gateway.serverTools()[0].input_schema).toMatchObject({
      required: ["state", "questions"],
    })
  })

  test("sends the state and questions to /v1/systemone and answers in compact text", async () => {
    const { fake, harness } = await start({ reply })

    const result = await run(harness, {
      state: { message: "Checkout is down" },
      questions,
    })

    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([
      {
        type: "text",
        text: [
          "refund: noul, probability 0",
          "severity: score 0.78 (0 = first level), confidence 0.71 (Minor 0.22, Major 0.78)",
          'team: choice "engineering", confidence 0.99 (billing 0, engineering 1)',
        ].join("\n"),
      },
    ])
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].path).toBe("/v1/systemone")
    expect(fake.calls[0].body).toEqual({
      model: "microsoft-decision-1",
      state: { message: "Checkout is down" },
      questions,
    })
  })

  test("refuses input the model can't accept without calling upstream", async () => {
    const { fake, harness } = await start()

    for (const bad of [
      { questions },
      { state: "x" },
      { state: "x", questions: {} },
    ]) {
      expect((await run(harness, bad)).isError).toBe(true)
    }
    expect(fake.calls).toHaveLength(0)
  })

  test("an upstream failure is an error result, not a throw", async () => {
    const { fake, harness } = await start()
    fake.enqueue(new Error("Bad Request"))

    const result = await run(harness, { state: "x", questions })

    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({
      text: "Failed to run SystemOne: Bad Request",
    })
  })

  test("is registered only while the model is on the plan and the provider signed in", async () => {
    const { fake, harness } = await start()
    expect(toolNames(harness)).toEqual(["systemone/classify"])

    fake.setModels([])
    expect(toolNames(harness)).toEqual([])

    fake.setModels([catalogModel("microsoft-decision-1")])
    expect(toolNames(harness)).toEqual(["systemone/classify"])

    await harness.disable("systemone")
    expect(toolNames(harness)).toEqual([])
  })

  test("`tools.classify: false` keeps it out", async () => {
    const { harness } = await start()

    await harness.setConfig("systemone", { tools: { classify: false } })
    await harness.flush()

    expect(toolNames(harness)).toEqual([])
  })

  test("the description is fixed: no live state", async () => {
    const { harness } = await start()

    expect(harness.gateway.serverTools()[0].description).not.toMatch(
      /microsoft|\d{4}-\d{2}|copilot/i,
    )
  })
})
