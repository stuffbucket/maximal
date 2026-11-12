/**
 * What the image tools accept from the model and what they send upstream:
 * the input checks, the size clamp and the request bodies for the two
 * operations. Pure, so the budget estimate and `execute` read the same input
 * the same way.
 */

export const MAX_IMAGES = 4
export const MAX_PROMPT_CHARS = 32_000

export const QUALITIES = ["low", "medium", "high"] as const
export type Quality = (typeof QUALITIES)[number]

export const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const
export type OutputFormat = (typeof OUTPUT_FORMATS)[number]

export const DEFAULT_SIZE = "1024x1024"

// The model's size rules (images.md): both edges divisible by 16, no edge
// over 3840, 655 360 to 8 294 400 pixels in all, aspect ratio within 3:1.
const STEP = 16
const MAX_EDGE = 3840
const MIN_PIXELS = 655_360
const MAX_PIXELS = 8_294_400
const MAX_RATIO = 3

/** Why an input is refused; the text goes back to the model. */
export class ImageToolInputError extends Error {}

export interface ImageRequest {
  prompt: string
  size: string
  quality: Quality
  n: number
  outputFormat: OutputFormat
}

function fail(message: string): never {
  throw new ImageToolInputError(message)
}

/** The allowed value `value` names (any case), `undefined` when it names none. */
function choice<T extends string>(
  value: unknown,
  allowed: ReadonlyArray<T>,
  name: string,
): T | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") {
    const lower = value.toLowerCase()
    const found = allowed.find((item) => item === lower)
    if (found) return found
  }
  return fail(`${name} must be one of: ${allowed.join(", ")}.`)
}

const BAD_SIZE = 'size must look like "1024x1024".'

/** `[width, height]` of a `WxH` size text; `undefined` for none or `auto`. */
function parseSize(raw: unknown): [number, number] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "string") return fail("size must be a string.")
  const text = raw.trim().toLowerCase()
  if (text === "" || text === "auto") return undefined
  const match = /^(\d{1,5})\s*[x×]\s*(\d{1,5})$/u.exec(text)
  if (!match) return fail(BAD_SIZE)
  const width = Number(match[1])
  const height = Number(match[2])
  return width < 1 || height < 1 ? fail(BAD_SIZE) : [width, height]
}

/** How far to scale `pixels` to land in the range, and which way to round. */
function fitToRange(pixels: number): {
  scale: number
  round: (value: number) => number
} {
  if (pixels < MIN_PIXELS) {
    return { scale: Math.sqrt(MIN_PIXELS / pixels), round: Math.ceil }
  }
  if (pixels > MAX_PIXELS) {
    return { scale: Math.sqrt(MAX_PIXELS / pixels), round: Math.floor }
  }
  return { scale: 1, round: Math.round }
}

function inRange(width: number, height: number): boolean {
  const area = width * height
  return (
    area >= MIN_PIXELS
    && area <= MAX_PIXELS
    && width <= height * MAX_RATIO
    && height <= width * MAX_RATIO
  )
}

/**
 * The size as `WIDTHxHEIGHT` the model accepts: the aspect ratio capped at
 * 3:1, scaled into the pixel range and rounded to multiples of 16. A size
 * that is not `WIDTHxHEIGHT` (or `auto`, taken as the default) is refused.
 */
export function clampSize(raw: unknown): string {
  const parsed = parseSize(raw)
  if (!parsed) return DEFAULT_SIZE
  const [asked, askedHeight] = parsed
  const width = Math.min(asked, askedHeight * MAX_RATIO)
  const height = Math.min(askedHeight, asked * MAX_RATIO)
  const { scale, round } = fitToRange(width * height)
  const edge = (value: number): number =>
    Math.min(MAX_EDGE, Math.max(STEP, round((value * scale) / STEP) * STEP))
  const fitted = { width: edge(width), height: edge(height) }
  // Rounding or the edge cap can push a pathological size out of range.
  return inRange(fitted.width, fitted.height) ?
      `${fitted.width}x${fitted.height}`
    : DEFAULT_SIZE
}

/** The shared fields of both tools' input, checked and defaulted. */
export function parseImageRequest(
  input: Record<string, unknown>,
): ImageRequest {
  const { prompt } = input
  if (typeof prompt !== "string" || prompt.trim() === "") {
    return fail("prompt is required: describe the image in words.")
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return fail(`prompt is too long (at most ${MAX_PROMPT_CHARS} characters).`)
  }
  const rawN = input.n ?? 1
  if (
    typeof rawN !== "number"
    || !Number.isInteger(rawN)
    || rawN < 1
    || rawN > MAX_IMAGES
  ) {
    return fail(`n must be a whole number from 1 to ${MAX_IMAGES}.`)
  }
  return {
    prompt,
    size: clampSize(input.size),
    quality: choice(input.quality, QUALITIES, "quality") ?? "low",
    n: rawN,
    outputFormat:
      choice(input.output_format, OUTPUT_FORMATS, "output_format") ?? "png",
  }
}

/** The `images.generations` body. `stream` and `gif` are never sent (images.md). */
export function generationBody(
  request: ImageRequest,
  upstreamModel: string,
): Record<string, unknown> {
  return {
    model: upstreamModel,
    prompt: request.prompt,
    size: request.size,
    quality: request.quality,
    n: request.n,
    output_format: request.outputFormat,
  }
}

/** One input image of an edit, already read and checked. */
export interface EditImageFile {
  name: string
  mimeType: string
  bytes: Uint8Array<ArrayBuffer>
}

/** The `images.edits` multipart body (`image[]` parts). */
export function editBody(
  request: ImageRequest,
  upstreamModel: string,
  files: ReadonlyArray<EditImageFile>,
): FormData {
  const form = new FormData()
  form.append("model", upstreamModel)
  form.append("prompt", request.prompt)
  form.append("size", request.size)
  form.append("quality", request.quality)
  form.append("n", String(request.n))
  form.append("output_format", request.outputFormat)
  for (const file of files) {
    form.append(
      "image[]",
      new File([file.bytes], file.name, { type: file.mimeType }),
    )
  }
  return form
}
