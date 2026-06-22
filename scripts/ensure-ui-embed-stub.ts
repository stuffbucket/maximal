#!/usr/bin/env bun
/**
 * Write the empty `src/generated/ui-embed.ts` stub if it's missing.
 *
 * `src/generated/` is gitignored (it holds generated embed code). Fresh
 * clones therefore lack the module that src/routes/ui/route.ts imports,
 * which would break `tsc`/tests before a build runs. This script — wired
 * into `prepare` (runs on `bun install`) — guarantees the stub exists.
 * A real build overwrites it via scripts/gen-ui-embed.ts.
 */
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

const OUT = resolve(import.meta.dir, "..", "src/generated/ui-embed.ts")

if (existsSync(OUT)) process.exit(0)

const stub = `// GENERATED (stub) by scripts/ensure-ui-embed-stub.ts — do not edit.
// The real version is written by scripts/gen-ui-embed.ts before
// \`bun build --compile\` and lists the built UI assets embedded into the
// proxy binary. This empty stub is what dev/tests see: with no embedded
// files, the proxy serves the UI from shell/dist on disk instead (see
// src/routes/ui/route.ts).

export interface UiEmbedEntry {
  /** Embedded file path (a \\$bunfs path inside the compiled binary). */
  path: string
  /** Content-Type to serve the asset with. */
  type: string
}

export const UI_FILES: Record<string, UiEmbedEntry | undefined> = {}
`

await mkdir(dirname(OUT), { recursive: true })
await Bun.write(OUT, stub)
console.error("[ensure-ui-embed-stub] wrote stub src/generated/ui-embed.ts")
