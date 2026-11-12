/**
 * The `classify` server tool: yes/no (`noul`), choice and score answers from
 * Microsoft-Decision-1 over a text or JSON state. The description and schema
 * are fixed (they are part of the prompt-cache prefix).
 */
import type {
  Context,
  JsonSchemaObject,
  ServerToolDefinition,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk"

import {
  callBoundModel,
  errorResult,
  textResult,
} from "@stuffbucket/maximal-plugin-sdk"

import type { SystemOneConfig } from "./manifest"

export const CLASSIFY_TOOL = "classify"

const DESCRIPTION =
  "Ask a fast classifier typed questions about some text or JSON and get back numeric answers, not text: a probability that something is true (noul), the best of several named options (choice) or a score on an ordered scale (score). Use it for cheap gates, routing and ranking, e.g. whether a message asks for a refund, which team owns a ticket, or how severe a failure is. Put everything the questions rely on in `state`; ask one thing per question. It cannot write, explain or look anything up, and answers are estimates to weigh, not facts."

const INPUT_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    state: {
      type: ["string", "object", "array"],
      description: "The text or JSON every question is answered from.",
    },
    questions: {
      type: "object",
      minProperties: 1,
      description:
        "Questions keyed by a short unique name; the answers come back under the same names.",
      additionalProperties: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["noul", "choice", "score"],
            description:
              "noul: probability the statement is true. choice: pick one key of `criteria`. score: place on the ordered `criteria` list.",
          },
          instructions: {
            type: "string",
            description: "The statement or question to decide.",
          },
          criteria: {
            type: ["object", "array"],
            description:
              "choice: an object of option name to description (2 or more). score: an array of 2 to 10 level names, lowest first. noul: optional object with `true` and `false` descriptions.",
          },
        },
        required: ["type", "instructions"],
      },
    },
  },
  required: ["state", "questions"],
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const round = (value: unknown): string =>
  typeof value === "number" && Number.isFinite(value) ?
    String(Math.round(value * 100) / 100)
  : "?"

/** The problem with the model's input, or undefined when it can be sent. */
function inputProblem(input: Record<string, unknown>): string | undefined {
  if (input.state === undefined || input.state === null) {
    return "classify needs `state`: the text or JSON to evaluate."
  }
  if (!isRecord(input.questions) || Object.keys(input.questions).length === 0) {
    return "classify needs `questions`: an object keyed by question name."
  }
  return undefined
}

function odds(probabilities: unknown, label: (key: string) => string): string {
  if (!isRecord(probabilities)) return ""
  return Object.entries(probabilities)
    .map(([key, probability]) => `${label(key)} ${round(probability)}`)
    .join(", ")
}

function describeAnswer(name: string, answer: unknown): string {
  if (!isRecord(answer)) return `${name}: ${JSON.stringify(answer)}`
  switch (answer.type) {
    case "noul": {
      return `${name}: noul, probability ${round(answer.noul)}`
    }
    case "choice": {
      return `${name}: choice ${JSON.stringify(answer.choice)}, confidence ${round(answer.confidence)} (${odds(answer.probabilities, (key) => key)})`
    }
    case "score": {
      const legend = isRecord(answer.legend) ? answer.legend : {}
      const label = (key: string) =>
        typeof legend[key] === "string" ? legend[key] : key
      return `${name}: score ${round(answer.score)} (0 = first level), confidence ${round(answer.confidence)} (${odds(answer.probabilities, label)})`
    }
    default: {
      return `${name}: ${JSON.stringify(answer)}`
    }
  }
}

/** The reply as one line per answer. */
export function formatClassification(
  reply: Record<string, unknown>,
): ToolResult {
  const answers = reply.answers
  if (!isRecord(answers) || Object.keys(answers).length === 0) {
    return errorResult("The classifier returned no answers.")
  }
  return textResult(
    Object.entries(answers)
      .map(([name, answer]) => describeAnswer(name, answer))
      .join("\n"),
  )
}

export function classifyTool(
  ctx: Context,
  config: SystemOneConfig,
  path: string,
): ServerToolDefinition {
  return {
    name: CLASSIFY_TOOL,
    description: DESCRIPTION,
    input_schema: INPUT_SCHEMA,
    render: "hidden",
    offer: "always",
    async execute(input, call) {
      const problem = inputProblem(input)
      if (problem) return errorResult(problem)
      const result = await callBoundModel(ctx, config.bindings, {
        path,
        errorMessage: "Failed to run SystemOne",
        body: { state: input.state, questions: input.questions },
        signal: call.signal,
      })
      return "error" in result ?
          result.error
        : formatClassification(result.reply)
    },
  }
}
