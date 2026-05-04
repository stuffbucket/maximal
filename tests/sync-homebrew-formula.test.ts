import { describe, expect, it } from "bun:test"
import fs from "node:fs"

import {
  parseSha256File,
  renderFormula,
} from "../scripts/sync-homebrew-formula"

const ARM_SHA = "a".repeat(64)

describe("parseSha256File", () => {
  it("parses the canonical `<sha>  <name>` line", () => {
    const content = `${ARM_SHA}  copilot-api-v1.9.4-darwin-arm64.tar.gz\n`
    expect(
      parseSha256File(content, "copilot-api-v1.9.4-darwin-arm64.tar.gz"),
    ).toBe(ARM_SHA)
  })

  it("ignores trailing newlines and whitespace", () => {
    const content = `${ARM_SHA}  copilot-api-v1.9.4-darwin-arm64.tar.gz   \n\n`
    expect(
      parseSha256File(content, "copilot-api-v1.9.4-darwin-arm64.tar.gz"),
    ).toBe(ARM_SHA)
  })

  it("rejects malformed content", () => {
    expect(() => parseSha256File("not-a-hash file", "file")).toThrow()
    expect(() => parseSha256File("", "file")).toThrow()
  })

  it("rejects when the filename in the .sha256 doesn't match the expected asset", () => {
    const content = `${ARM_SHA}  unexpected-name.tar.gz\n`
    expect(() => parseSha256File(content, "expected-name.tar.gz")).toThrow(
      /expected/,
    )
  })

  it("matches by basename so absolute or relative paths in the .sha256 are accepted", () => {
    const content = `${ARM_SHA}  ./dist/copilot-api-v1.0.0-darwin-arm64.tar.gz\n`
    expect(
      parseSha256File(content, "copilot-api-v1.0.0-darwin-arm64.tar.gz"),
    ).toBe(ARM_SHA)
  })
})

describe("renderFormula", () => {
  const template = fs.readFileSync("build/homebrew/copilot-api.rb", "utf8")

  it("substitutes every placeholder in the shipped template", () => {
    const out = renderFormula(template, {
      org: "microsoft-internal",
      version: "1.9.4",
      armSha: ARM_SHA,
    })
    expect(out).not.toContain("PLACEHOLDER_ORG")
    expect(out).not.toContain("PLACEHOLDER_VERSION")
    expect(out).not.toContain("PLACEHOLDER_SHA256_DARWIN_ARM64")
    expect(out).toContain('version "1.9.4"')
    expect(out).toContain(`sha256 "${ARM_SHA}"`)
    expect(out).toContain("microsoft-internal/copilot-api")
  })

  it("renders a syntactically plausible Ruby formula", () => {
    const out = renderFormula(template, {
      org: "x",
      version: "0.0.0",
      armSha: ARM_SHA,
    })
    // Sanity checks for the structural pieces a Homebrew core
    // formula MUST have.
    expect(out).toMatch(/^class CopilotApi < Formula$/m)
    expect(out).toMatch(/^\s*def install$/m)
    expect(out).toMatch(/^\s*service do$/m)
    expect(out).toMatch(/^\s*test do$/m)
    expect(out).toMatch(/^end$/m)
  })
})
