import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import {
  ALL_LANGUAGES,
  isIgnored,
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
