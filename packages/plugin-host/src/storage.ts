import type { PluginStorageBackend } from "@stuffbucket/maximal-plugin-sdk/runtime"

import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const DIR_MODE = 0o700
const FILE_MODE = 0o600

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === code
  )
}

/**
 * Filesystem `ctx.storage` backend: `<root>/<pluginId>/<name>`. Directories
 * are 0700, files are written atomically (temp file + rename) with mode 0600
 * — the same convention as `src/lib/auth/secrets.ts`. Names are validated by
 * the storage service before they reach this backend.
 */
export function createFileStorage(root: string): PluginStorageBackend {
  const absoluteRoot = path.resolve(root)
  const dir = (pluginId: string) => path.join(absoluteRoot, pluginId)

  async function ensureDir(pluginId: string): Promise<string> {
    const target = dir(pluginId)
    await mkdir(target, { recursive: true, mode: DIR_MODE })
    if (process.platform !== "win32") await chmod(target, DIR_MODE)
    return target
  }

  return {
    dir,
    async readText(pluginId, name) {
      try {
        return await readFile(path.join(dir(pluginId), name), "utf8")
      } catch (error) {
        if (isErrno(error, "ENOENT")) return undefined
        throw error
      }
    },
    async writeText(pluginId, name, text) {
      const target = await ensureDir(pluginId)
      const temp = path.join(target, `.${name}.${randomUUID()}.tmp`)
      try {
        await writeFile(temp, text, {
          encoding: "utf8",
          mode: FILE_MODE,
          flag: "wx",
        })
        await rename(temp, path.join(target, name))
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {})
        throw error
      }
    },
    async delete(pluginId, name) {
      await rm(path.join(dir(pluginId), name), { force: true })
    },
  }
}
