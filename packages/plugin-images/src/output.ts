/**
 * Where the image tools put what the model returns: decoded from `b64_json`,
 * written under the output folder as `<yyyyMMdd-HHmmss>-<shortid>.<ext>`,
 * atomically (temp file, then rename) with mode 0600. Nothing here ever hands
 * base64 back to the model.
 */
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { OUTPUT_FORMATS, type OutputFormat } from "./request"

export interface SavedImage {
  path: string
  bytes: number
  format: OutputFormat
  revisedPrompt?: string
}

const two = (value: number): string => String(value).padStart(2, "0")

function stamp(now: Date): string {
  return (
    `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
    + `-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
  )
}

function formatOf(reported: unknown, requested: OutputFormat): OutputFormat {
  const text = typeof reported === "string" ? reported.toLowerCase() : ""
  return OUTPUT_FORMATS.find((format) => format === text) ?? requested
}

/**
 * Save every image of an images reply under `dir` (created with mode 0700).
 * A reply with no `b64_json` image is an error, not an empty success.
 */
export async function saveImages(
  dir: string,
  reply: Record<string, unknown>,
  requested: OutputFormat,
): Promise<Array<SavedImage>> {
  const data = Array.isArray(reply.data) ? (reply.data as Array<unknown>) : []
  const format = formatOf(reply.output_format, requested)
  const items = data.flatMap((entry) => {
    const record =
      typeof entry === "object" && entry !== null ?
        (entry as Record<string, unknown>)
      : {}
    return typeof record.b64_json === "string" && record.b64_json !== "" ?
        [
          {
            b64: record.b64_json,
            revised:
              typeof record.revised_prompt === "string" ?
                record.revised_prompt
              : undefined,
          },
        ]
      : []
  })
  if (items.length === 0) {
    throw new Error("The model returned no image.")
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const saved: Array<SavedImage> = []
  for (const item of items) {
    const bytes = Buffer.from(item.b64, "base64")
    if (bytes.length === 0)
      throw new Error("The model returned an empty image.")
    const file = path.join(
      dir,
      `${stamp(new Date())}-${randomBytes(4).toString("hex")}.${format === "jpeg" ? "jpg" : format}`,
    )
    const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`
    try {
      await fs.writeFile(temp, bytes, { mode: 0o600, flag: "wx" })
      await fs.rename(temp, file)
    } catch (error) {
      await fs.rm(temp, { force: true })
      throw error
    }
    saved.push({
      path: file,
      bytes: bytes.length,
      format,
      ...(item.revised === undefined ? {} : { revisedPrompt: item.revised }),
    })
  }
  return saved
}
