import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { PATHS } from "~/lib/platform/paths"

function canonicalProfileDirectory(directory: string): string {
  const resolved = path.resolve(directory)
  const missing: Array<string> = []
  let ancestor = resolved
  let canonical = resolved
  for (;;) {
    try {
      canonical = path.join(fs.realpathSync.native(ancestor), ...missing)
      break
    } catch {
      const parent = path.dirname(ancestor)
      if (parent === ancestor) break
      missing.unshift(path.basename(ancestor))
      ancestor = parent
    }
  }
  const normalized = path.normalize(canonical).replaceAll("\\", "/")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

/** Stable, non-reversible identity for one Maximal data/profile directory. */
export function profileIdForDirectory(directory: string): string {
  return createHash("sha256")
    .update("maximal-profile-v1\0")
    .update(canonicalProfileDirectory(directory))
    .digest("hex")
}

export function currentProfileId(): string {
  return profileIdForDirectory(PATHS.APP_DIR)
}
