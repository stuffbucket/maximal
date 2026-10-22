import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")

function docs(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8")
}

describe("Codex integration documentation", () => {
  test("documents the narrow ownership and effective-layer boundaries", () => {
    const integration = docs("docs/dev/codex-integration.md")

    expect(integration).toContain("model_provider")
    expect(integration).toContain("[model_providers.<id>]")
    expect(integration).toContain("Never changed")
    expect(integration).toContain("command-line")
    expect(integration).toContain("admin")
    expect(integration).toContain("project")
    expect(integration).toContain("profile")
    expect(integration).toContain("cloud")
    expect(integration).toContain("cleanup-required")
    expect(integration).toContain("does not run Codex")
  })

  test("documents generic model mapping semantics and the editable default", () => {
    const integration = docs("docs/dev/codex-integration.md")
    const architecture = docs("docs/architecture.md")

    expect(integration).toContain("modelMappings")
    expect(integration).toContain("First match wins")
    expect(integration).toContain("one pass")
    expect(integration).toContain("codex-auto-review")
    expect(integration).toContain("gpt-5.6-luna")
    expect(integration).toContain("400")
    expect(integration).toContain("[]")
    expect(architecture).toContain("docs/dev/codex-integration.md")
  })
})
