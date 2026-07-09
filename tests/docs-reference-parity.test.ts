/**
 * Docs-reference parity — the testing strategy verifies itself.
 *
 * A strategy document rots the moment code is renamed underneath it: a reader
 * (or an external reviewer) hits a `src/…` path that no longer exists and stops
 * trusting the rest. This test turns that silent drift into a red build. It is
 * the same drift-guard shape as `i18n-catalog-parity.test.ts` and
 * `config-schema.test.ts` — a single source of truth (here, the repo tree)
 * checked against its mirrors (here, the docs' concrete references).
 *
 * It validates *validity*, not *choice*: it does not decide what a doc should
 * mention, only that everything it DOES mention as a repo path or `bun run`
 * script actually exists. Prose, illustrative code (`if (!hasThinking)`), env
 * vars, and glob/placeholder patterns (`*-route.test.ts`, `tests/<subject>…`)
 * are deliberately out of scope.
 *
 * Extending coverage is a one-line addition to DOCS. Intentional references to
 * a not-yet-existing path are an escape hatch via IGNORE (keep it small and
 * justified — every entry is a promise the parity guard can't keep).
 */
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dir, "..")

// Docs whose concrete references must stay live. Add more here as they are
// cleaned; a doc joins only once all its path/script tokens resolve.
const DOCS = ["docs/dev/testing-strategy.md", "docs/architecture.md"]

// Escape hatch: tokens we reference on purpose that are not (yet) repo paths.
// Empty by design — prefer fixing the reference over adding an exception.
const IGNORE = new Set<string>()

const TOP_DIRS = ["src", "tests", "scripts", "shell", "docs", ".github"]
const FULL_PATH_RE = new RegExp(`^(?:${TOP_DIRS.join("|")})/[\\w./-]+$`)
// Basenames we validate leniently: illustrative source/test files, NOT runtime
// data files (accounts.json, github_token) that live outside the repo tree.
const BASENAME_RE = /^\w[\w.-]*\.(?:test\.)?tsx?$/
const isPlaceholder = (t: string): boolean => /[*<>]/.test(t)

// One-time index of every source-tree file basename → how many exist.
function buildBasenameIndex(): Map<string, number> {
  const index = new Map<string, number>()
  const roots = ["src", "tests", "scripts", "shell/src", "docs", ".github"]
  const walk = (dir: string): void => {
    let entries: Array<fs.Dirent>
    try {
      entries = fs.readdirSync(path.join(REPO_ROOT, dir), {
        withFileTypes: true,
      })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue
      const rel = path.join(dir, e.name)
      if (e.isDirectory()) walk(rel)
      else index.set(e.name, (index.get(e.name) ?? 0) + 1)
    }
  }
  for (const r of roots) walk(r)
  return index
}

const basenameIndex = buildBasenameIndex()
const pkg = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "package.json")) as unknown as string,
) as { scripts?: Record<string, string> }
const scripts = new Set(Object.keys(pkg.scripts ?? {}))

function backtickedTokens(doc: string): Array<string> {
  return [...doc.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim())
}
function bunRunScripts(doc: string): Array<string> {
  return [...doc.matchAll(/\bbun run ([\w:-]+)/g)].map((m) => m[1])
}

describe("docs reference parity", () => {
  for (const rel of DOCS) {
    const doc = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8")

    test(`${rel}: every referenced repo path exists`, () => {
      const missing: Array<string> = []
      for (const t of backtickedTokens(doc)) {
        if (IGNORE.has(t) || isPlaceholder(t)) continue
        // Strict: a full repo path must exist verbatim.
        if (FULL_PATH_RE.test(t) && !fs.existsSync(path.join(REPO_ROOT, t))) {
          missing.push(`${t} (path not found)`)
        } else if (
          !t.includes("/")
          && BASENAME_RE.test(t)
          && !basenameIndex.has(t)
        ) {
          // Lenient: an illustrative basename must resolve somewhere in the tree.
          missing.push(`${t} (no file with this name)`)
        }
      }
      expect(
        missing,
        `stale references in ${rel} — rename the doc or the code:\n  ${missing.join("\n  ")}`,
      ).toEqual([])
    })

    test(`${rel}: every 'bun run <script>' is defined in package.json`, () => {
      const undefinedScripts = [...new Set(bunRunScripts(doc))].filter(
        (s) => !scripts.has(s),
      )
      expect(
        undefinedScripts,
        `undefined bun scripts referenced in ${rel}:\n  ${undefinedScripts.join("\n  ")}`,
      ).toEqual([])
    })
  }
})
