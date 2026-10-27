/**
 * Decide which CodeQL languages a change needs scanned.
 *
 *   printf '%s\n' <changed paths…> | bun scripts/codeql-languages.ts
 *   echo ALL | bun scripts/codeql-languages.ts    # schedule, dispatch, unknown diff
 *
 * Prints a JSON array for the workflow matrix, e.g. ["javascript-typescript"].
 * A file only counts if CodeQL would analyze it: anything under the config's
 * `paths-ignore` is skipped here too, so the scan scope and the analysis scope
 * come from one list. Changing the CodeQL setup itself rescans everything.
 */

import { z } from "zod"

export const ALL_LANGUAGES = ["actions", "javascript-typescript", "rust"]

const CONFIG = ".github/codeql/codeql-config.yml"
const RESCAN_ALL = new Set([
  CONFIG,
  ".github/workflows/codeql.yml",
  "scripts/codeql-languages.ts",
])
const JS_SOURCE = /\.(?:[cm]?[jt]sx?|html?)$/
const JS_CONFIG = /(?:^|\/)(?:package\.json|tsconfig[\w.-]*\.json)$/
const RUST_SOURCE = /^shell\/src-tauri\/(?:.*\.rs|Cargo\.(?:toml|lock))$/

const CodeqlConfig = z.object({
  "paths-ignore": z.array(z.string()).default([]),
})

export function readPathsIgnore(yaml: string): Array<string> {
  return CodeqlConfig.parse(Bun.YAML.parse(yaml))["paths-ignore"]
}

/** CodeQL `paths-ignore` semantics: a literal entry is a path prefix; an
 *  entry with `*` is a glob matching the path or any directory above it. */
export function isIgnored(file: string, ignore: Array<string>): boolean {
  return ignore.some((entry) =>
    entry.includes("*") ?
      new Bun.Glob(entry).match(file) || new Bun.Glob(`${entry}/**`).match(file)
    : file === entry || file.startsWith(`${entry}/`),
  )
}

function languageOf(file: string, ignore: Array<string>): string | undefined {
  if (
    file.startsWith(".github/workflows/")
    || file.startsWith(".github/actions/")
  )
    return "actions"
  if (isIgnored(file, ignore)) return undefined
  if (RUST_SOURCE.test(file)) return "rust"
  if (JS_SOURCE.test(file) || JS_CONFIG.test(file))
    return "javascript-typescript"
  return undefined
}

export function languagesFor(
  changed: Array<string> | "all",
  ignore: Array<string>,
): Array<string> {
  if (changed === "all" || changed.some((file) => RESCAN_ALL.has(file)))
    return ALL_LANGUAGES
  const touched = new Set(
    changed.flatMap((file) => languageOf(file, ignore) ?? []),
  )
  return ALL_LANGUAGES.filter((language) => touched.has(language))
}

if (import.meta.main) {
  const input = (await new Response(Bun.stdin.stream()).text())
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
  const ignore = readPathsIgnore(await Bun.file(CONFIG).text())
  const changed = input.length === 0 || input.includes("ALL") ? "all" : input
  console.log(JSON.stringify(languagesFor(changed, ignore)))
}
