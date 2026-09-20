#!/usr/bin/env bun
/**
 * Pre-bundle cleanup — makes `tauri build --bundles dmg` idempotent.
 *
 * tauri's bundle_dmg.sh mounts a scratch volume at /Volumes/Maximal and writes
 * a `rw.<pid>.*.dmg` working image. A run that fails partway leaves one or both
 * behind, and that debris breaks the NEXT run:
 *   - a stale /Volumes/Maximal makes macOS mount the new scratch volume as
 *     "Maximal 1", which bundle_dmg.sh can't find → the bundle step fails;
 *   - stale `rw.*.dmg` images accumulate until bundling trips over them.
 * Clearing both before each build removes both recurring failure modes.
 *
 * macOS-only; a no-op elsewhere (the dmg bundle only runs on macOS).
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

if (process.platform !== "darwin") {
  process.exit(0)
}

function run(cmd: string, args: Array<string>): void {
  spawnSync(cmd, args, { stdio: ["ignore", "ignore", "ignore"] })
}

// 1) Detach stale Maximal volumes (an opened/installed DMG, or a failed run's
//    scratch mount). Strictly "Maximal" / "Maximal N" so no other volume is
//    touched. Detaching an installer DMG is harmless and fully reversible.
let volumes: Array<string> = []
try {
  volumes = fs.readdirSync("/Volumes").filter((v) => /^Maximal( \d+)?$/.test(v))
} catch {
  /* /Volumes unreadable — nothing to do */
}
for (const v of volumes) {
  run("hdiutil", ["detach", `/Volumes/${v}`, "-force"])
  console.log(`predmg-cleanup: detached /Volumes/${v}`)
}

// 2) Remove stale rw.*.dmg scratch images from the bundle output dir.
const macosDir = path.join(
  import.meta.dir,
  "..",
  "shell",
  "src-tauri",
  "target",
  "release",
  "bundle",
  "macos",
)
try {
  for (const f of fs.readdirSync(macosDir)) {
    if (/^rw\..+\.dmg$/.test(f)) {
      fs.rmSync(path.join(macosDir, f), { force: true })
      console.log(`predmg-cleanup: removed scratch image ${f}`)
    }
  }
} catch {
  /* bundle dir doesn't exist yet (clean tree) — nothing to clean */
}
