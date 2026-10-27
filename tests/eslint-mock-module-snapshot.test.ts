/**
 * eslint-rules/mock-module-snapshot.js: a mock.module factory must not read a
 * module's live namespace, because mock.module patches that namespace in place
 * and a restore built from it puts the stub back.
 */

import { describe, expect, test } from "bun:test"
import { ESLint, type Linter, RuleTester } from "eslint"
import path from "node:path"

import mockModuleSnapshot from "../eslint-rules/mock-module-snapshot.js"
import projectConfig from "../eslint.config.js"

RuleTester.describe = describe
RuleTester.it = test
RuleTester.itOnly = test.only

// Parse with the project's own TypeScript parser so `as` casts are covered.
const tsParser = (projectConfig as Array<Linter.Config>).find(
  (entry) => entry.name === "typescript-eslint/base",
)?.languageOptions?.parser

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: "latest",
    sourceType: "module",
  },
})

const liveNamespace = { messageId: "liveNamespace" }

ruleTester.run("mock-module-snapshot", mockModuleSnapshot, {
  valid: [
    // The documented fix: snapshot before mocking.
    `const real = { ...(await import("m")) }
     await mock.module("m", () => ({ ...real, sleep: () => {} }))
     await mock.module("m", () => real)`,
    // Spreading a static namespace into a snapshot is fine too.
    `import * as ns from "m"
     const real = { ...ns }
     await mock.module("m", () => real)`,
    // Destructured exports are copies taken before the mock.
    `const { sleep } = await import("m")
     await mock.module("m", () => ({ sleep }))`,
    // Reading the live namespace outside a factory is not this rule's concern.
    `const live = await import("m")
     const realSleep = live.sleep
     await mock.module("m", () => ({ sleep: realSleep }))`,
    // A factory passed by reference isn't inspected.
    `const live = await import("m")
     const factory = () => live
     await mock.module("m", factory)`,
    // Only mock.module factories are checked.
    `const live = await import("m")
     other.module("m", () => live)`,
  ],
  invalid: [
    {
      // The broken restore from #538.
      code: `const real = await import("m")
             await mock.module("m", () => ({ ...real, sleep: () => {} }))
             await mock.module("m", () => real)`,
      errors: [liveNamespace, liveNamespace],
    },
    {
      // A fresh spread at restore time copies the already-patched namespace.
      code: `const real = await import("m")
             await mock.module("m", () => ({ ...real }))`,
      errors: [liveNamespace],
    },
    {
      code: `import * as real from "m"
             await mock.module("m", () => real)`,
      errors: [liveNamespace],
    },
    {
      code: `const real = (await import("m")) as typeof import("m")
             await mock.module("m", () => real)`,
      errors: [liveNamespace],
    },
    {
      // Member reads inside the factory run after the patch, too.
      code: `const real = await import("m")
             await mock.module("m", function () { return { sleep: real.sleep } })`,
      errors: [liveNamespace],
    },
  ],
})

describe("mock-module-snapshot wiring", () => {
  test("is an error for every test file", async () => {
    const eslint = new ESLint({ cwd: path.join(import.meta.dir, "..") })
    const config = (await eslint.calculateConfigForFile(
      "tests/any.test.ts",
    )) as Linter.Config
    expect(config.rules?.["local/mock-module-snapshot"]).toEqual([2])
  })
})
