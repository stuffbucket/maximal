/**
 * `generate_image` and `edit_image`: hidden server tools the model calls in
 * the `/v1/messages` loop. Each dispatches the plugin's own operation
 * (`images.generations` / `images.edits`) through the first binding's
 * provider, reports what it spent, saves the pictures as files and answers
 * with their paths. No image data goes back into the model's context.
 */
import type {
  Context,
  ModelBinding,
  ModelOperation,
  OperationResult,
  RelaySpec,
  ServerToolCall,
  ServerToolDefinition,
  ServerToolEstimate,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk"

import {
  bindingsStatus,
  OperationUnavailableError,
  relayOperation,
} from "@stuffbucket/maximal-plugin-sdk"

import { readImageInput } from "./input-files"
import { saveImages } from "./output"
import {
  editBody,
  generationBody,
  type ImageRequest,
  ImageToolInputError,
  MAX_IMAGES,
  OUTPUT_FORMATS,
  parseImageRequest,
  QUALITIES,
} from "./request"
import { EDITS_SPEC, GENERATIONS_SPEC } from "./specs"

export const GENERATE_TOOL = "generate_image"
export const EDIT_TOOL = "edit_image"

const NANO_AIU_PER_CREDIT = 1_000_000_000

/** The first-call approval the tools wait for; see `index.ts`. */
export interface ToolGate {
  /** `undefined` when the call may go on; else the result to answer with. */
  check(): Promise<ToolResult | undefined>
}

export interface ImageToolsOptions {
  binding: ModelBinding & { model: string }
  /** The binding list the status helper reads (provider and model checks). */
  bindings: ReadonlyArray<ModelBinding & { model: string }>
  outputDir: string
  gate: ToolGate
}

const COMMON_PROPERTIES = {
  prompt: {
    type: "string",
    description: "What the image should show, or how to change it.",
  },
  size: {
    type: "string",
    description:
      'WIDTHxHEIGHT in pixels, for example "1024x1024" (default), "1536x1024" or "1024x1536".',
  },
  quality: {
    type: "string",
    enum: [...QUALITIES],
    description: "low (default) is cheapest; medium and high cost more.",
  },
  n: {
    type: "integer",
    minimum: 1,
    maximum: MAX_IMAGES,
    description: `How many images (default 1, at most ${MAX_IMAGES}). Each is billed.`,
  },
  output_format: {
    type: "string",
    enum: [...OUTPUT_FORMATS],
    description: "File format (default png).",
  },
} as const

const GENERATE_DESCRIPTION =
  "Generate an image from a text description with an image model. The image is saved as a file on this computer and the file path is returned; the picture itself is not shown here. Each image is billed to the user's model provider and counts against their spend limits, so generate only what the user asked for."

const EDIT_DESCRIPTION =
  "Edit or combine existing image files (.png, .jpg, .webp, given by absolute path) following a text instruction. The result is saved as a new file and its path is returned; the originals are not changed. Billed to the user's model provider like generate_image."

const errorResult = (text: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
})

function failureText(error: unknown): string {
  if (error instanceof ImageToolInputError) return error.message
  if (error instanceof OperationUnavailableError) {
    return "Image generation isn't available right now."
  }
  const reason = error instanceof Error ? error.message : String(error)
  return `The image request failed: ${reason}`
}

function creditsOf(nanoAiu: number | undefined): number | undefined {
  return nanoAiu === undefined ? undefined : (
      Math.round((nanoAiu / NANO_AIU_PER_CREDIT) * 100) / 100
    )
}

interface Variant {
  name: string
  description: string
  operation: ModelOperation
  spec: RelaySpec
  extraProperties: Record<string, unknown>
  required: Array<string>
  /** The body to send, built (and for edits, the files read) from the input. */
  body(
    request: ImageRequest,
    input: Record<string, unknown>,
    upstreamModel: string,
  ): Promise<Record<string, unknown> | FormData>
}

const VARIANTS: ReadonlyArray<Variant> = [
  {
    name: GENERATE_TOOL,
    description: GENERATE_DESCRIPTION,
    operation: "images.generations",
    spec: GENERATIONS_SPEC,
    extraProperties: {},
    required: ["prompt"],
    body: (request, _input, upstreamModel) =>
      Promise.resolve(generationBody(request, upstreamModel)),
  },
  {
    name: EDIT_TOOL,
    description: EDIT_DESCRIPTION,
    operation: "images.edits",
    spec: EDITS_SPEC,
    extraProperties: {
      images: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_IMAGES,
        description:
          "Absolute paths of the image files to edit (png, jpg or webp). The first is the main image.",
      },
    },
    required: ["prompt", "images"],
    body: async (request, input, upstreamModel) => {
      const paths: unknown = input.images
      if (
        !Array.isArray(paths)
        || paths.length === 0
        || paths.length > MAX_IMAGES
      ) {
        throw new ImageToolInputError(
          `images must list 1 to ${MAX_IMAGES} image file paths.`,
        )
      }
      const files = []
      for (const file of paths as Array<unknown>) {
        files.push(await readImageInput(file))
      }
      return editBody(request, upstreamModel, files)
    },
  },
]

/** The request the input makes, or `undefined` when `execute` would refuse it. */
function tryParse(input: Record<string, unknown>): ImageRequest | undefined {
  try {
    return parseImageRequest(input)
  } catch {
    return undefined
  }
}

function reportProviderSpend(
  call: ServerToolCall,
  result: OperationResult,
  details: { operation: ModelOperation; model: string; provider: string },
): void {
  call.reportSpend?.({
    invocationId: result.invocationId,
    providerCallId: result.providerCallId,
    sequence: result.sequence,
    operation: details.operation,
    model: details.model,
    provider: details.provider,
    result,
  })
}

function definitionOf(
  ctx: Context,
  options: ImageToolsOptions,
  variant: Variant,
): ServerToolDefinition {
  const { binding } = options
  return {
    name: variant.name,
    description: variant.description,
    input_schema: {
      type: "object",
      properties: { ...COMMON_PROPERTIES, ...variant.extraProperties },
      required: variant.required,
    },
    render: "hidden",
    offer: "always",
    // The core estimates from quality and count, the way it does for the HTTP
    // route; an edit's files are not read just to price it.
    estimate(input): ServerToolEstimate | undefined {
      const request = tryParse(input)
      if (!request) return undefined
      return {
        operation: variant.operation,
        provider: binding.provider,
        body: { quality: request.quality, n: request.n },
      }
    },
    async execute(input, call: ServerToolCall): Promise<ToolResult> {
      try {
        const held = await options.gate.check()
        if (held) return held
        const request = parseImageRequest(input)
        const status = bindingsStatus(ctx, options.bindings, "images")
        if (status.state !== "ready") return errorResult(status.summary)
        const body = await variant.body(request, input, binding.upstreamModel)
        const providerCall = call.nextProviderCall(
          variant.operation,
          binding.upstreamModel,
        )
        const result = await relayOperation(
          ctx,
          {
            operation: variant.operation,
            model: binding.model,
            binding,
            body,
            signal: call.signal,
            invocationId: providerCall.invocationId,
            providerCallId: providerCall.providerCallId,
            sequence: providerCall.sequence,
            origin: {
              kind: "server-tool",
              tool: variant.name,
              ...(call.sessionId === undefined ?
                {}
              : { sessionId: call.sessionId }),
            },
          },
          variant.spec,
        )
        // Before anything that can fail on our side: the provider billed it.
        reportProviderSpend(call, result, {
          operation: variant.operation,
          model: binding.model,
          provider: binding.provider,
        })
        const saved = await saveImages(
          options.outputDir,
          result.json,
          request.outputFormat,
        )
        const credits = creditsOf(result.cost?.amount)
        const files = saved.map((image) => image.path)
        const revised = saved.find(
          (image) => image.revisedPrompt,
        )?.revisedPrompt
        const lines = [
          `${saved.length === 1 ? "Saved 1 image" : `Saved ${saved.length} images`} (${request.size}, ${request.quality} quality):`,
          ...files,
          ...(credits === undefined ? [] : [`Cost: about ${credits} credits.`]),
        ]
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: {
            images: saved.map((image) => ({
              path: image.path,
              bytes: image.bytes,
              format: image.format,
            })),
            size: request.size,
            quality: request.quality,
            ...(revised === undefined ? {} : { revised_prompt: revised }),
            ...(credits === undefined ? {} : { cost_credits: credits }),
          },
        }
      } catch (error) {
        return errorResult(failureText(error))
      }
    },
  }
}

/** The enabled tools' definitions. */
export function imageTools(
  ctx: Context,
  options: ImageToolsOptions,
  enabled: { generate: boolean; edit: boolean },
): Array<ServerToolDefinition> {
  return VARIANTS.filter((variant) =>
    variant.name === GENERATE_TOOL ? enabled.generate : enabled.edit,
  ).map((variant) => definitionOf(ctx, options, variant))
}
