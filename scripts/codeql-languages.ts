/**
 * Decide which CodeQL languages a change needs scanned.
 *
 *   printf '%s\n' <changed paths…> | bun scripts/codeql-languages.ts
 *   echo ALL | bun scripts/codeql-languages.ts    # schedule, dispatch, unknown diff
 *   bun scripts/codeql-languages.ts --package-before old.json \
 *     --package-after new.json < changed.txt
 *
 * Prints a JSON array for the workflow matrix, e.g. ["javascript-typescript"].
 * A file only counts if CodeQL would analyze it: anything under the config's
 * `paths-ignore` is skipped here too, so the scan scope and the analysis scope
 * come from one list. A package.json change is skipped only when complete,
 * parseable before/after files prove that its top-level version is the sole
 * semantic change. Changing the CodeQL setup itself rescans everything.
 */

import { isDeepStrictEqual } from "node:util"

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

export interface PackageJsonChange {
  before: string
  after: string
}

interface PackageJsonContents {
  version: string
  rest: Record<string, unknown>
}

function packageJsonContents(source: string): PackageJsonContents | undefined {
  try {
    const parsed: unknown = JSON.parse(source)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return undefined

    const { version, ...rest } = parsed as Record<string, unknown>
    if (typeof version !== "string") return undefined
    return { version, rest }
  } catch {
    return undefined
  }
}

export function isVersionOnlyPackageJsonChange({
  before,
  after,
}: PackageJsonChange): boolean {
  const oldContents = packageJsonContents(before)
  const newContents = packageJsonContents(after)
  return (
    oldContents !== undefined
    && newContents !== undefined
    && oldContents.version !== newContents.version
    && isDeepStrictEqual(oldContents.rest, newContents.rest)
  )
}

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

function languageOf(
  file: string,
  ignore: Array<string>,
  packageJsonChange?: PackageJsonChange,
): string | undefined {
  if (
    file.startsWith(".github/workflows/")
    || file.startsWith(".github/actions/")
  )
    return "actions"
  if (isIgnored(file, ignore)) return undefined
  if (RUST_SOURCE.test(file)) return "rust"
  if (
    file === "package.json"
    && packageJsonChange !== undefined
    && isVersionOnlyPackageJsonChange(packageJsonChange)
  )
    return undefined
  if (JS_SOURCE.test(file) || JS_CONFIG.test(file))
    return "javascript-typescript"
  return undefined
}

export function languagesFor(
  changed: Array<string> | "all",
  ignore: Array<string>,
  packageJsonChange?: PackageJsonChange,
): Array<string> {
  if (changed === "all" || changed.some((file) => RESCAN_ALL.has(file)))
    return ALL_LANGUAGES
  const touched = new Set(
    changed.flatMap(
      (file) => languageOf(file, ignore, packageJsonChange) ?? [],
    ),
  )
  return ALL_LANGUAGES.filter((language) => touched.has(language))
}

async function packageJsonChangeFromArgs(
  args: Array<string>,
): Promise<PackageJsonChange | undefined> {
  if (args.length === 0) return undefined
  if (
    args.length !== 4
    || args[0] !== "--package-before"
    || args[2] !== "--package-after"
  )
    throw new Error(
      "usage: codeql-languages.ts [--package-before FILE --package-after FILE]",
    )

  return {
    before: await Bun.file(args[1]).text(),
    after: await Bun.file(args[3]).text(),
  }
}

if (import.meta.main) {
  const input = (await new Response(Bun.stdin.stream()).text())
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
  const ignore = readPathsIgnore(await Bun.file(CONFIG).text())
  const changed = input.length === 0 || input.includes("ALL") ? "all" : input
  const packageJsonChange = await packageJsonChangeFromArgs(Bun.argv.slice(2))
  console.log(JSON.stringify(languagesFor(changed, ignore, packageJsonChange)))
}
