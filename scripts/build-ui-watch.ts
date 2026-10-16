/**
 * Watch-mode rebuild policy for `scripts/build-ui.ts --watch`: rebuild only
 * when an input's contents changed, run one build at a time, and never leave
 * the output behind the sources.
 *
 * Filesystem events alone can't decide that. Each build copies `vendor/`
 * out of shell/ui, and on macOS that copy is reported as events on the
 * source files although nothing in them changed, so rebuilding on every
 * event rebuilt forever. Instead each event compares a hash of the inputs'
 * paths and bytes with the hash the current output was built from.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"

/** Every non-hidden file under `root` (or `root` itself, if it's a file),
 *  sorted so the signature doesn't depend on directory order. */
async function inputFiles(root: string): Promise<Array<string>> {
  let info
  try {
    info = await stat(root)
  } catch {
    return []
  }
  if (info.isFile()) return [root]
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !path.relative(root, file).split(path.sep).some((part) => part.startsWith(".")))
    .sort()
}

/** A hash of every input file's path and contents. Equal signatures mean
 *  the same build output; timestamps and copies don't change it. */
export async function inputSignature(roots: Array<string>): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const root of roots) {
    for (const file of await inputFiles(root)) {
      hasher.update(`${file}\0`)
      hasher.update(await readFile(file))
      hasher.update("\0")
    }
  }
  return hasher.digest("hex")
}

export interface RebuilderOptions {
  /** The inputs' current signature. */
  signature: () => Promise<string>
  build: () => Promise<void>
  /** Signature the existing output was built from. */
  built: string
  onError: (error: unknown) => void
}

/**
 * Returns `request`, to call on every change event. A request while a build
 * runs doesn't start a second one; it makes the running one check again
 * when it finishes, so a change made mid-build is always built. The
 * signature is taken before each build, so anything newer differs from it.
 * A failed build leaves `built` alone, so the next request retries it.
 */
export function createRebuilder(options: RebuilderOptions): () => Promise<void> {
  let built = options.built
  let running: Promise<void> | undefined
  let again = false

  const drain = async (): Promise<void> => {
    do {
      again = false
      const next = await options.signature()
      if (next === built) continue
      try {
        await options.build()
        built = next
      } catch (error) {
        options.onError(error)
      }
    } while (again)
  }

  const request = (): Promise<void> => {
    if (running) {
      again = true
      return running
    }
    running = drain().finally(() => {
      running = undefined
      // A request between the last check and here still gets its build.
      if (again) void request()
    })
    return running
  }
  return request
}
