#!/usr/bin/env bun
/**
 * Write the empty `src/generated/ui-embed.ts` stub if it's missing.
 *
 * `src/generated/` is gitignored (it holds generated embed code). Fresh
 * clones — and fresh `git worktree add` checkouts, which do NOT run
 * `bun install` — therefore lack the module that src/routes/ui/route.ts
 * imports, which would break `tsc`/eslint/knip/tests before a build runs.
 *
 * `ensureUiEmbedStub()` is the reusable, synchronous guarantee. It's wired
 * into three places so the stub exists no matter how the tree was set up:
 *   - `prepare` (this file as a script — runs on `bun install`),
 *   - `check:fast` (covers lint/typecheck/knip via `check:deep`),
 *   - the test preload (`tests/test-setup.ts`, covers bare `bun test`).
 * A real build overwrites the stub via scripts/gen-ui-embed.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

const OUT = resolve(import.meta.dir, "..", "src/generated/ui-embed.ts")

const STUB = `// GENERATED (stub) by scripts/ensure-ui-embed-stub.ts — do not edit.
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

/**
 * Synchronously guarantee `src/generated/ui-embed.ts` exists. Returns `true`
 * if it wrote the stub, `false` if a file was already there (real or stub).
 * Cheap and idempotent — safe to call from hot paths like the test preload.
 *
 * Uses an atomic exclusive create (`wx` = O_CREAT|O_EXCL) rather than a
 * check-then-write, so concurrent callers can't race between an `existsSync`
 * probe and the write (CodeQL js/file-system-race). Whoever creates it first
 * wins; everyone else sees EEXIST and treats it as "already present".
 *
 * `force: true` overwrites unconditionally — used by the TEST preload, which
 * REQUIRES the empty stub (so `HAS_EMBED` is false and the UI route serves from
 * the test's fixture dir). A stray `build:ui` / `app:dev` / `ui:harness` run
 * otherwise leaves a populated embed behind, silently reddening the ui-route
 * tests on the next `bun test`. Returns true when the stub was (re)written.
 */
export function ensureUiEmbedStub(force = false): boolean {
  mkdirSync(dirname(OUT), { recursive: true })
  if (force) {
    writeFileSync(OUT, STUB)
    return true
  }
  try {
    writeFileSync(OUT, STUB, { flag: "wx" })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false
    throw err
  }
}

if (import.meta.main) {
  if (ensureUiEmbedStub()) {
    console.error("[ensure-ui-embed-stub] wrote stub src/generated/ui-embed.ts")
  }
}
