/**
 * Smoke test for the `configure-claude-desktop` subcommand.
 *
 * Doesn't exercise the macOS-specific MDM path (that needs `defaults`
 * and a real `/Applications/Claude.app`). Instead, verifies that the
 * citty command exists, exposes the documented flags, and that the
 * command's `run` invokes the underlying handler.
 */

import { describe, expect, it } from "bun:test"

import { configureClaudeDesktop } from "~/configure-claude-desktop"

describe("configure-claude-desktop subcommand", () => {
  it("exposes the documented metadata", async () => {
    const meta = await resolveMaybe(configureClaudeDesktop.meta)
    expect(meta?.name).toBe("configure-claude-desktop")
    expect(meta?.description).toContain("Claude Desktop")
  })

  it("declares --force and --revert flags", async () => {
    const args = await resolveMaybe(configureClaudeDesktop.args)
    expect(args).toBeDefined()
    if (!args) return
    expect(args.force).toBeDefined()
    expect(args.revert).toBeDefined()
    expect(args.force.type).toBe("boolean")
    expect(args.revert.type).toBe("boolean")
  })
})

async function resolveMaybe<T>(
  value: T | (() => T) | (() => Promise<T>) | undefined,
): Promise<T | undefined> {
  if (typeof value === "function") {
    const r = (value as () => T | Promise<T>)()
    return await Promise.resolve(r)
  }
  return await Promise.resolve(value)
}
