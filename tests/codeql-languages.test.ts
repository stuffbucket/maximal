import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import {
  ALL_LANGUAGES,
  isIgnored,
  isVersionOnlyPackageJsonChange,
  languagesFor,
  readPathsIgnore,
} from "../scripts/codeql-languages"

const IGNORE = ["tests", "packages/storybook", "**/vendor", "**/*.min.js"]

describe("isIgnored", () => {
  test.each([
    ["tests/a.test.ts", true],
    ["tests", true],
    ["testsuite/a.ts", false],
    ["packages/storybook/src/x.tsx", true],
    ["shell/ui/dashboard/vendor/lucide.min.js", true],
    ["site/public/app.min.js", true],
    ["src/server.ts", false],
  ])("%s → %p", (file, ignored) => {
    expect(isIgnored(file, IGNORE)).toBe(ignored)
  })
})

describe("isVersionOnlyPackageJsonChange", () => {
  test("accepts a changed version with otherwise equal semantic content", () => {
    expect(
      isVersionOnlyPackageJsonChange({
        before: '{"name":"maximal","version":"1.0.0","private":true}',
        after: `{
          "private": true,
          "version": "1.0.1",
          "name": "maximal"
        }`,
      }),
    ).toBe(true)
  })

  test("rejects substantive, missing-version, and malformed changes", () => {
    expect(
      isVersionOnlyPackageJsonChange({
        before: '{"version":"1.0.0","scripts":{"test":"bun test"}}',
        after: '{"version":"1.0.1","scripts":{"test":"bun test --watch"}}',
      }),
    ).toBe(false)
    expect(
      isVersionOnlyPackageJsonChange({
        before: '{"name":"maximal"}',
        after: '{"name":"maximal","version":"1.0.1"}',
      }),
    ).toBe(false)
    expect(
      isVersionOnlyPackageJsonChange({
        before: '{"version":"1.0.0"}',
        after: "not json",
      }),
    ).toBe(false)
  })
})

describe("languagesFor", () => {
  test("a TypeScript source change scans only JS/TS", () => {
    expect(languagesFor(["src/server.ts"], IGNORE)).toEqual([
      "javascript-typescript",
    ])
  })

  test("a Rust change scans only Rust", () => {
    expect(languagesFor(["shell/src-tauri/src/lib.rs"], IGNORE)).toEqual([
      "rust",
    ])
    expect(languagesFor(["shell/src-tauri/Cargo.lock"], IGNORE)).toEqual([
      "rust",
    ])
  })

  test("a workflow or composite action change scans Actions", () => {
    expect(languagesFor([".github/workflows/ci.yml"], IGNORE)).toEqual([
      "actions",
    ])
    expect(
      languagesFor([".github/actions/setup-bun/action.yml"], IGNORE),
    ).toEqual(["actions"])
  })

  test("changes CodeQL would never analyze scan nothing", () => {
    expect(
      languagesFor(
        [
          "docs/architecture.md",
          "tests/server.test.ts",
          "packages/storybook/src/Button.stories.tsx",
          "shell/ui/dashboard/vendor/tailwind.min.js",
          "shell/src-tauri/icons/icon.png",
        ],
        IGNORE,
      ),
    ).toEqual([])
  })

  test("a mixed change scans each touched language once, in a stable order", () => {
    expect(
      languagesFor(
        [
          ".github/workflows/ci.yml",
          "shell/src-tauri/src/lib.rs",
          "src/a.ts",
          "src/b.ts",
        ],
        IGNORE,
      ),
    ).toEqual(["actions", "javascript-typescript", "rust"])
  })

  test("JS config files that change extraction count as JS/TS", () => {
    expect(languagesFor(["package.json"], IGNORE)).toEqual([
      "javascript-typescript",
    ])
    expect(languagesFor(["shell/tsconfig.json"], IGNORE)).toEqual([
      "javascript-typescript",
    ])
  })

  test("a proven package version-only release change does not scan JS/TS", () => {
    const versionOnly = {
      before: '{"name":"maximal","version":"1.0.0"}',
      after: '{"name":"maximal","version":"1.0.1"}',
    }

    expect(
      languagesFor(
        [".release-please-manifest.json", "CHANGELOG.md", "package.json"],
        IGNORE,
        versionOnly,
      ),
    ).toEqual([])
    expect(
      languagesFor(
        ["package.json", "shell/src-tauri/src/lib.rs"],
        IGNORE,
        versionOnly,
      ),
    ).toEqual(["rust"])
    expect(
      languagesFor(["package.json", "src/server.ts"], IGNORE, versionOnly),
    ).toEqual(["javascript-typescript"])
  })

  test("a substantive or uncertain package change scans JS/TS", () => {
    const substantive = {
      before: '{"version":"1.0.0","dependencies":{"zod":"4.0.0"}}',
      after: '{"version":"1.0.1","dependencies":{"zod":"4.1.0"}}',
    }
    const malformed = {
      before: '{"version":"1.0.0"}',
      after: "not json",
    }

    expect(languagesFor(["package.json"], IGNORE, substantive)).toEqual([
      "javascript-typescript",
    ])
    expect(languagesFor(["package.json"], IGNORE, malformed)).toEqual([
      "javascript-typescript",
    ])
    expect(languagesFor(["package.json"], IGNORE)).toEqual([
      "javascript-typescript",
    ])
  })

  test("changing the CodeQL setup itself rescans everything", () => {
    for (const file of [
      ".github/codeql/codeql-config.yml",
      ".github/workflows/codeql.yml",
      "scripts/codeql-languages.ts",
    ]) {
      expect(languagesFor([file], IGNORE)).toEqual(ALL_LANGUAGES)
    }
  })

  test('"all" (unknown or too-large diff, schedule, dispatch) rescans everything', () => {
    expect(languagesFor("all", IGNORE)).toEqual(ALL_LANGUAGES)
    expect(
      languagesFor("all", IGNORE, {
        before: '{"version":"1.0.0"}',
        after: '{"version":"1.0.1"}',
      }),
    ).toEqual(ALL_LANGUAGES)
  })
})

describe("the CodeQL workflow", () => {
  const workflow = fs.readFileSync(
    path.join(import.meta.dir, "..", ".github", "workflows", "codeql.yml"),
    "utf8",
  )

  test("classifies package changes from complete before and after contents", () => {
    expect(workflow).toContain("contents/package.json?ref=$base")
    expect(workflow).toContain("contents/package.json?ref=$head")
    expect(workflow).toContain("--package-before package-before.json")
    expect(workflow).toContain("--package-after package-after.json")
  })

  test("falls back to ordinary path classification when content is unavailable", () => {
    expect(workflow).toContain("rm -f package-before.json package-after.json")
    expect(workflow).toContain(
      "Could not compare package.json contents; scanning JavaScript/TypeScript",
    )
  })

  test("keeps merge-group ranges and scheduled or manual full scans", () => {
    expect(workflow).toContain("merge_group:")
    expect(workflow).toContain('merge_group)  range="$MG_BASE...$MG_HEAD"')
    expect(workflow).toContain("schedule:")
    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain('*)            range=""')
  })

  test("fails closed when a main push is not a fast-forward", () => {
    expect(workflow).toContain(
      `if [ "$EVENT" = "push" ] && [ "$(jq -r '.status // ""' "$comparison")" != "ahead" ]`,
    )
    expect(workflow).toContain(
      "Non-fast-forward push comparison; scanning all languages",
    )
    expect(workflow).toContain("echo ALL > changed.txt")
  })
})

describe("the real CodeQL config", () => {
  const configPath = path.join(
    import.meta.dir,
    "..",
    ".github",
    "codeql",
    "codeql-config.yml",
  )
  const ignore = readPathsIgnore(fs.readFileSync(configPath, "utf8"))

  test("ignores tests and never ignores shipped source", () => {
    expect(isIgnored("tests/server.test.ts", ignore)).toBe(true)
    expect(isIgnored("src/server.ts", ignore)).toBe(false)
    expect(isIgnored("shell/src/main.ts", ignore)).toBe(false)
    expect(isIgnored("packages/mcp-broker/src/broker-server.ts", ignore)).toBe(
      false,
    )
  })

  test("every literal paths-ignore entry exists, so none is dead config", () => {
    const root = path.join(import.meta.dir, "..")
    for (const entry of ignore.filter((e) => !e.includes("*"))) {
      expect(fs.existsSync(path.join(root, entry))).toBe(true)
    }
  })
})
