/**
 * The `decide` server tool: yes/no, choice and score answers from the
 * decision model, over evidence the model passes in. The description and
 * schema are fixed (they are part of the prompt-cache prefix).
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

import type { DecisionsConfig } from "./manifest"

export const DECIDE_TOOL = "decide"

const DESCRIPTION =
  "Ask a fast decision model typed questions about some evidence and get back numeric answers, not text: a probability that a statement is true (predicate), the best of several options (choice) or a score on an ordered scale (score). Use it for cheap gates, routing and grading, e.g. whether an error log shows a flaky test, which of three files a change belongs in, or how risky a diff is. Put everything the questions rely on in `input`; ask one thing per question. It cannot write, explain or look anything up, and answers are estimates to weigh, not facts."

const INPUT_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    input: {
      type: "string",
      description:
        "The evidence every question is answered from: text, or JSON as a string.",
    },
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      description: "Questions answered independently, in this order.",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["predicate", "choice", "score"],
            description:
              "predicate: probability the instructions' statement is true. choice: pick one of `choices`. score: place on the ordered `levels`.",
          },
          name: {
            type: "string",
            minLength: 1,
            description: "A short unique label for the answer.",
          },
          instructions: {
            type: "string",
            description: "The statement or question to decide.",
          },
          choices: {
            type: "array",
            minItems: 2,
            description: "For choice: 2 or more options.",
            items: {
              type: "object",
              properties: {
                value: { type: "string" },
                description: { type: "string" },
              },
              required: ["value"],
            },
          },
          levels: {
            type: "array",
            minItems: 2,
            maxItems: 10,
            description: "For score: 2 to 10 levels, lowest first.",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                description: { type: "string" },
              },
              required: ["label"],
            },
          },
        },
        required: ["type", "name", "instructions"],
      },
    },
  },
  required: ["input", "questions"],
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const round = (value: unknown): string =>
  typeof value === "number" && Number.isFinite(value) ?
    String(Math.round(value * 100) / 100)
  : "?"

/** The problem with the model's input, or undefined when it can be sent. */
function inputProblem(input: Record<string, unknown>): string | undefined {
  if (typeof input.input !== "string" || input.input === "") {
    return "decide needs `input`: the evidence, as a non-empty string."
  }
  const questions = input.questions
  if (!Array.isArray(questions) || questions.length === 0) {
    return "decide needs `questions`: a non-empty array."
  }
  for (const [index, question] of questions.entries()) {
    if (
      !isRecord(question)
      || typeof question.name !== "string"
      || question.name === ""
    ) {
      return `Question ${index + 1} needs a non-empty \`name\`.`
    }
  }
  return undefined
}

function describeAnswer(answer: Record<string, unknown>): string {
  const name = typeof answer.name === "string" ? answer.name : "?"
  const probabilities = (
    list: unknown,
    label: (p: Record<string, unknown>) => string,
  ) =>
    Array.isArray(list) ?
      list
        .filter((p) => isRecord(p))
        .map((p) => `${label(p)} ${round(p.probability)}`)
        .join(", ")
    : ""
  switch (answer.type) {
    case "predicate": {
      return `${name}: predicate, probability ${round(answer.probability)}`
    }
    case "choice": {
      const odds = probabilities(answer.probabilities, (p) => String(p.value))
      return `${name}: choice ${JSON.stringify(answer.choice)}, confidence ${round(answer.confidence)} (${odds})`
    }
    case "score": {
      const odds = probabilities(answer.probabilities, (p) =>
        typeof p.label === "string" ? p.label : String(p.value),
      )
      return `${name}: score ${round(answer.score)} (0 = first level), confidence ${round(answer.confidence)} (${odds})`
    }
    case "refusal": {
      return `${name}: refused`
    }
    default: {
      return `${name}: ${JSON.stringify(answer)}`
    }
  }
}

/** The reply as one line per answer, in question order. */
export function formatDecisions(reply: Record<string, unknown>): ToolResult {
  const answers = reply.answers
  if (!Array.isArray(answers) || answers.length === 0) {
    return errorResult("The decision model returned no answers.")
  }
  return textResult(
    answers
      .filter((answer) => isRecord(answer))
      .map((answer) => describeAnswer(answer))
      .join("\n"),
  )
}

export function decideTool(
  ctx: Context,
  config: DecisionsConfig,
  path: string,
): ServerToolDefinition {
  return {
    name: DECIDE_TOOL,
    description: DESCRIPTION,
    input_schema: INPUT_SCHEMA,
    render: "hidden",
    offer: "always",
    async execute(input, call) {
      const problem = inputProblem(input)
      if (problem) return errorResult(problem)
      const result = await callBoundModel(ctx, config.bindings, {
        path,
        errorMessage: "Failed to create decisions",
        body: { input: input.input, questions: input.questions },
        signal: call.signal,
      })
      return "error" in result ? result.error : formatDecisions(result.reply)
    },
  }
}
