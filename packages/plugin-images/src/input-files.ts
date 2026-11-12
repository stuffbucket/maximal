/**
 * Reading the input files of `edit_image`: only image files, named by an
 * absolute path, with no `..`, no symlink that leaves its own folder and a
 * size cap. What the model names is untrusted (a prompt-injected model could
 * name `~/.ssh/id_rsa`), so a file counts only if its extension is an image
 * type AND its first bytes are that image's magic number.
 *
 * This is not a path allowlist (which folders may be read is a later
 * decision); it keeps non-image files and links out of the upload.
 */
import fs from "node:fs/promises"
import path from "node:path"

import { type EditImageFile, ImageToolInputError } from "./request"

/** Per file; the model accepts up to 50 MB (images.md), this is a tighter cap. */
export const MAX_INPUT_BYTES = 20 * 1024 * 1024

const EXTENSIONS: Readonly<Record<string, string | undefined>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** The image type the first bytes say, or `undefined`. */
export function sniffImageType(head: Uint8Array): string | undefined {
  if (PNG.every((byte, index) => head[index] === byte)) return "image/png"
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return "image/jpeg"
  }
  const ascii = (from: number, to: number): string =>
    String.fromCodePoint(...head.subarray(from, to))
  if (head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return "image/webp"
  }
  return undefined
}

function refuse(file: string, why: string): never {
  throw new ImageToolInputError(`Can't use ${file}: ${why}`)
}

/** `child` is `parent` or inside it. */
function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return (
    relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
}

async function resolveReadable(file: string): Promise<string> {
  const link = await fs.lstat(file)
  if (!link.isSymbolicLink()) return file
  const [target, home] = await Promise.all([
    fs.realpath(file),
    fs.realpath(path.dirname(file)),
  ])
  if (!within(home, target)) {
    return refuse(file, "it is a link that points outside its own folder.")
  }
  return target
}

/**
 * Read one input image. Throws `ImageToolInputError` (its text goes back to
 * the model) for anything that is not a readable image file.
 */
export async function readImageInput(file: unknown): Promise<EditImageFile> {
  if (typeof file !== "string" || file.trim() === "" || file.includes("\0")) {
    return refuse(String(file), "image paths must be non-empty text.")
  }
  if (!path.isAbsolute(file)) {
    return refuse(file, "give an absolute path.")
  }
  if (file.split(/[/\\]/u).includes("..")) {
    return refuse(file, 'paths with ".." are not allowed.')
  }
  const mimeType = EXTENSIONS[path.extname(file).toLowerCase()]
  if (mimeType === undefined) {
    return refuse(file, "only .png, .jpg, .jpeg and .webp files are read.")
  }
  let real: string
  try {
    real = await resolveReadable(file)
  } catch (error) {
    if (error instanceof ImageToolInputError) throw error
    return refuse(file, "the file does not exist or can't be read.")
  }
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(real, "r")
    const info = await handle.stat()
    if (!info.isFile()) return refuse(file, "it is not a regular file.")
    if (info.size > MAX_INPUT_BYTES) {
      return refuse(
        file,
        `it is larger than ${MAX_INPUT_BYTES / (1024 * 1024)} MB.`,
      )
    }
    const bytes = new Uint8Array(new ArrayBuffer(info.size))
    const { bytesRead } = await handle.read(bytes, 0, info.size, 0)
    const sniffed = sniffImageType(bytes.subarray(0, bytesRead))
    if (sniffed === undefined) {
      return refuse(file, "its contents are not a PNG, JPEG or WebP image.")
    }
    return {
      name: path.basename(file),
      mimeType: sniffed,
      bytes: bytes.subarray(0, bytesRead),
    }
  } catch (error) {
    if (error instanceof ImageToolInputError) throw error
    return refuse(file, "the file can't be read.")
  } finally {
    await handle?.close()
  }
}
