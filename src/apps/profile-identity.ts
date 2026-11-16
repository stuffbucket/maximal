import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { PATHS } from "~/lib/platform/paths"

function canonicalProfileDirectory(directory: string): string {
  const resolved = path.resolve(directory)
  let canonical = resolved
  try {
    canonical = fs.realpathSync.native(resolved)
  } catch {
    // The profile directory may not exist on the first run. path.resolve still
    // gives it a deterministic identity, and no directory is created merely to
    // mint that identity.
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
