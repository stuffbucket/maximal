import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"

import {
  BASELINE_PATH,
  extractPin,
  normalizeTag,
  parseSemver,
  renderReport,
  repoPath,
  semverGt,
  VERSION_PINS,
  type WatchResult,
} from "./watch-external-drift"

// This suite is deterministic and offline — it exercises the pure logic and,
// crucially, acts as the PARITY GUARD: if someone renames a pinned constant
// in src/, extractPin() throws here and reds the build before the daily
// watcher can silently start reporting a bogus "?" pin.

describe("pin parity (source of truth = src/)", () => {
  test("every version pin still resolves in its source file", async () => {
    for (const spec of VERSION_PINS) {
      const source = await fs.readFile(repoPath(spec.file), "utf8")
      const value = extractPin(spec, source)
      expect(value).toMatch(/^\d+\.\d+\.\d+$/u)
    }
  })

  test("extractPin throws a clear error when the pattern is gone", () => {
    const [spec] = VERSION_PINS
    expect(() => extractPin(spec, "// constant removed")).toThrow(spec.id)
  })
})

describe("semver compare", () => {
  test("detects a strictly newer upstream", () => {
    expect(semverGt("2.1.205", "2.1.112")).toBe(true)
    expect(semverGt("1.17.18", "1.14.29")).toBe(true)
    expect(semverGt("1.0.0", "0.46.0")).toBe(true)
  })

  test("does not flag equal or older upstream", () => {
    expect(semverGt("0.43.0", "0.46.0")).toBe(false)
    expect(semverGt("2.1.112", "2.1.112")).toBe(false)
  })

  test("tolerates v / sdk-v tag prefixes", () => {
    expect(parseSemver("v0.43.0")).toEqual([0, 43, 0])
    expect(parseSemver("sdk-v0.110.0")).toEqual([0, 110, 0])
    expect(semverGt("sdk-v0.111.0", "0.110.0")).toBe(true)
  })
})

describe("normalizeTag", () => {
  test("strips release prefixes down to bare semver", () => {
    expect(normalizeTag("v2.1.205")).toBe("2.1.205")
    expect(normalizeTag("sdk-v0.110.0")).toBe("0.110.0")
    expect(normalizeTag("1.17.18")).toBe("1.17.18")
  })
})

describe("baseline fixture", () => {
  test("anthropicSdkStatsSha is a 40-hex git blob sha", async () => {
    const raw = await fs.readFile(BASELINE_PATH)
    const parsed = JSON.parse(raw.toString()) as {
      anthropicSdkStatsSha: string
    }
    expect(parsed.anthropicSdkStatsSha).toMatch(/^[0-9a-f]{40}$/u)
  })
})

describe("report rendering", () => {
  const results: Array<WatchResult> = [
    {
      id: "opencode",
      describe: "opencode client",
      drift: true,
      local: "1.14.29",
      upstream: "1.17.18",
      file: "src/lib/config/api-config.ts",
      upstreamUrl: "https://github.com/sst/opencode/releases/tag/1.17.18",
      note: "bump the pin to 1.17.18",
    },
    {
      id: "copilotChat",
      describe: "copilot chat",
      drift: false,
      local: "0.46.0",
      upstream: "0.43.0",
      note: "matches",
    },
  ]

  test("includes drifted watches and omits clean ones", () => {
    const body = renderReport(results)
    expect(body).toContain("opencode")
    expect(body).toContain("1.17.18")
    expect(body).not.toContain("copilotChat")
  })

  test("renders PR-derivable detail: file, review link, reconcile step", () => {
    const body = renderReport(results)
    expect(body).toContain("**file to change:** `src/lib/config/api-config.ts`")
    expect(body).toContain(
      "[review the change](https://github.com/sst/opencode/releases/tag/1.17.18)",
    )
    expect(body).toContain("**to reconcile:** bump the pin to 1.17.18")
  })

  test("a source-less watch (failed check) renders no empty file/link markup", () => {
    const body = renderReport([
      {
        id: "anthropicSdk",
        describe: "spec",
        drift: true,
        local: "?",
        upstream: "?",
        note: "check failed",
      },
    ])
    expect(body).toContain("anthropicSdk")
    expect(body).toContain("**to reconcile:** check failed")
    expect(body).not.toContain("**file to change:**")
    expect(body).not.toContain("[review the change]")
  })
})
