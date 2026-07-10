/**
 * Docs-reference parity — the testing strategy verifies itself.
 *
 * A strategy document rots the moment code is renamed underneath it: a reader
 * (or an external reviewer) hits a `src/…` path that no longer exists and stops
 * trusting the rest. This test turns that silent drift into a red build. It is
 * the same drift-guard shape as `i18n-catalog-parity.test.ts` and
 * `config-schema.test.ts` — a single source of truth (here, the set of
 * git-tracked files) checked against its mirrors (here, the docs' concrete
 * references).
 *
 * It validates against GIT-TRACKED paths, not the filesystem: a clean CI
 * checkout is the ground truth, so a build artifact that happens to exist in a
 * developer's working tree does NOT count. (Using `fs.existsSync` here caused
 * exactly the "green locally, red CI" failure §5.4 warns about.)
 *
 * It validates *validity*, not *choice*: it does not decide what a doc should
 * mention, only that everything it DOES mention as a repo path or `bun run`
 * script actually exists in the tree. Prose, illustrative code, env vars, and
 * glob/placeholder patterns (`*-route.test.ts`, `tests/<subject>…`,
 * `shell/ui/{settings,dashboard}`) are deliberately out of scope.
 *
 * Extending coverage is a one-line addition to DOCS. Intentional references to
 * a legitimately-untracked path (generated stubs, build outputs) go in IGNORE
 * with a justification — every entry is a promise the parity guard can't keep.
 */
import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dir, "..")

// Docs whose concrete references must stay live. Add more here as they are
// cleaned; a doc joins only once all its path/script tokens resolve.
const DOCS = ["docs/dev/testing-strategy.md", "docs/architecture.md"]

// Escape hatch: references that are real but intentionally NOT git-tracked —
// generated stubs and build outputs a clean checkout won't have. Keep small.
const IGNORE = new Set<string>([
  "src/generated/ui-embed.ts", // gitignored stub, created by the test preload
  "shell/dist", // gitignored web-UI build output
  "shell/src-tauri/binaries/", // gitignored sidecar binary output
])

const TOP_DIRS = ["src", "tests", "scripts", "shell", "docs", ".github"]
const FULL_PATH_RE = new RegExp(`^(?:${TOP_DIRS.join("|")})/[\\w./-]+$`)
const BASENAME_RE = /^\w[\w.-]*\.(?:test\.)?tsx?$/
const isPlaceholder = (t: string): boolean => /[*<>{}]/.test(t)

// Ground truth: what a clean checkout of this branch contains.
const trackedList = execFileSync("git", ["ls-files"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\n")
  .filter(Boolean)
const trackedFiles = new Set(trackedList)
const trackedDirs = new Set<string>()
for (const f of trackedList) {
  const parts = f.split("/")
  for (let i = 1; i < parts.length; i++)
    trackedDirs.add(parts.slice(0, i).join("/"))
}
const trackedBasenames = new Set(
  trackedList.map((f) => f.slice(f.lastIndexOf("/") + 1)),
)
function isTracked(token: string): boolean {
  const clean = token.replace(/\/+$/, "")
  return trackedFiles.has(clean) || trackedDirs.has(clean)
}

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
function markdownLinks(doc: string): Array<string> {
  return [...doc.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1].trim())
}

describe("docs reference parity", () => {
  for (const rel of DOCS) {
    const doc = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8")

    test(`${rel}: every referenced repo path is git-tracked`, () => {
      const missing: Array<string> = []
      for (const t of backtickedTokens(doc)) {
        if (IGNORE.has(t) || isPlaceholder(t)) continue
        // Strict: a full repo path must be tracked.
        if (FULL_PATH_RE.test(t) && !isTracked(t)) {
          missing.push(`${t} (path not in git)`)
        } else if (
          !t.includes("/")
          && BASENAME_RE.test(t)
          && !trackedBasenames.has(t)
        ) {
          // Lenient: an illustrative basename must resolve somewhere in the tree.
          missing.push(`${t} (no tracked file with this name)`)
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

    test(`${rel}: every relative markdown link resolves`, () => {
      const dir = path.dirname(rel)
      const broken: Array<string> = []
      for (const link of markdownLinks(doc)) {
        if (/^(?:https?:|mailto:|#)/.test(link)) continue
        const target = link.split("#")[0]
        if (!target) continue
        if (!isTracked(path.normalize(path.join(dir, target)))) {
          broken.push(link)
        }
      }
      expect(
        broken,
        `broken markdown links in ${rel}:\n  ${broken.join("\n  ")}`,
      ).toEqual([])
    })
  }
})
