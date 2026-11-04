import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

/** Run the broker (the compiled one when MAXIMAL_MCP_BROKER_BINARY is set). */
const run = (...args: Array<string>) => {
  const compiled = process.env.MAXIMAL_MCP_BROKER_BINARY
  const result = spawnSync(
    compiled ?? process.execPath,
    compiled ? args : [resolve(import.meta.dir, "../src/main.ts"), ...args],
    { encoding: "utf8", input: "", timeout: 20_000, windowsHide: true },
  )
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe("command line", () => {
  it("prints its version", () => {
    const result = run("--version")
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/^maximal-mcp-broker \S+ \(control protocol \d+\)\n$/u)
  })

  it("prints usage for --help, for either mode", () => {
    for (const args of [["--help"], ["stdio-adapter", "--help"], ["serve", "-h"]]) {
      const result = run(...args)
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("maximal-mcp-broker stdio-adapter --url")
    }
  })

  it("says how to use it when the arguments are wrong", () => {
    for (const args of [[], ["bogus"], ["stdio-adapter"]]) {
      const result = run(...args)
      expect(result.code).toBe(2)
      expect(result.stderr).toContain("Usage:")
      expect(result.stderr).toContain("[maximal-mcp-broker] USAGE\n")
    }
  })

  it("names what's wrong with an adapter URL", () => {
    const result = run("stdio-adapter", "--url", "http://example.com/mcp/x")
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(
      "[maximal-mcp-broker] ADAPTER_ENDPOINT_INVALID\n",
    )
  })
})
