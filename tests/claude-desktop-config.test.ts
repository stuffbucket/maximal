import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  alreadyConfigured,
  applyProxyConfig,
  DEFAULT_PROXY_VALUES,
  mergeProxyKeys,
  readClaudeDesktopConfig,
  revertProxyConfig,
  stripProxyKeys,
  writeClaudeDesktopConfig,
} from "~/lib/claude-desktop-config"

const TMP_ROOT = path.join(os.tmpdir(), `claude-config-test-${Date.now()}`)
let dir: string
let configPath: string

beforeEach(() => {
  dir = path.join(TMP_ROOT, `case-${crypto.randomUUID()}`)
  fs.mkdirSync(dir, { recursive: true })
  configPath = path.join(dir, "claude_desktop_config.json")
})

afterEach(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

function writeRaw(value: string): void {
  fs.writeFileSync(configPath, value)
}

describe("readClaudeDesktopConfig", () => {
  it("returns {} when the file is absent", () => {
    expect(readClaudeDesktopConfig(configPath)).toEqual({})
  })

  it("returns {} for empty file", () => {
    writeRaw("")
    expect(readClaudeDesktopConfig(configPath)).toEqual({})
  })

  it("returns {} for malformed JSON", () => {
    writeRaw("{ not valid json")
    expect(readClaudeDesktopConfig(configPath)).toEqual({})
  })

  it("returns {} when top-level is not an object", () => {
    writeRaw("[]")
    expect(readClaudeDesktopConfig(configPath)).toEqual({})
    writeRaw("42")
    expect(readClaudeDesktopConfig(configPath)).toEqual({})
  })

  it("parses a valid config", () => {
    writeRaw(JSON.stringify({ foo: "bar", n: 1 }))
    expect(readClaudeDesktopConfig(configPath)).toEqual({ foo: "bar", n: 1 })
  })
})

describe("mergeProxyKeys / stripProxyKeys / alreadyConfigured", () => {
  it("merge sets only our three keys, preserves others", () => {
    const merged = mergeProxyKeys({
      existingUserKey: "left alone",
      mcpServers: { foo: { command: "bar" } },
    })
    expect(merged.existingUserKey).toBe("left alone")
    expect(merged.mcpServers).toEqual({ foo: { command: "bar" } })
    expect(merged.inferenceProvider).toBe("gateway")
    expect(merged.inferenceGatewayBaseUrl).toBe("http://localhost:4141")
    expect(merged.inferenceGatewayApiKey).toBe("anything")
  })

  it("merge overwrites a different proxy value", () => {
    const merged = mergeProxyKeys({
      inferenceProvider: "vertex",
      inferenceGatewayBaseUrl: "http://192.0.2.1:9999",
    })
    expect(merged.inferenceProvider).toBe("gateway")
    expect(merged.inferenceGatewayBaseUrl).toBe("http://localhost:4141")
  })

  it("strip removes only our keys", () => {
    const stripped = stripProxyKeys({
      ...DEFAULT_PROXY_VALUES,
      myCustomKey: "stays",
      mcpServers: { x: 1 },
    })
    expect(stripped).toEqual({ myCustomKey: "stays", mcpServers: { x: 1 } })
  })

  it("alreadyConfigured returns true only when all three values match", () => {
    const matching: Record<string, unknown> = { ...DEFAULT_PROXY_VALUES }
    expect(alreadyConfigured(matching)).toBe(true)
    expect(alreadyConfigured({ ...matching, otherKey: 1 })).toBe(true)
    expect(
      alreadyConfigured({ ...matching, inferenceProvider: "vertex" }),
    ).toBe(false)
    expect(alreadyConfigured({})).toBe(false)
  })
})

describe("writeClaudeDesktopConfig", () => {
  it("creates parent directory if missing", () => {
    const nested = path.join(dir, "a", "b", "c", "config.json")
    writeClaudeDesktopConfig(nested, { foo: "bar" })
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer
    expect(JSON.parse(fs.readFileSync(nested, "utf8"))).toEqual({
      foo: "bar",
    })
  })

  it("writes JSON with trailing newline", () => {
    writeClaudeDesktopConfig(configPath, { foo: 1 })
    const raw = fs.readFileSync(configPath, "utf8")
    expect(raw.endsWith("\n")).toBe(true)
    expect(JSON.parse(raw)).toEqual({ foo: 1 })
  })

  it("does not leave .tmp behind on success", () => {
    writeClaudeDesktopConfig(configPath, { foo: 1 })
    expect(fs.existsSync(`${configPath}.tmp`)).toBe(false)
  })
})

describe("applyProxyConfig (end-to-end)", () => {
  it("creates the file with our keys when absent", () => {
    const result = applyProxyConfig(configPath)
    expect(result.wrote).toBe(true)
    expect(result.preservedKeys).toEqual([])
    expect(readClaudeDesktopConfig(configPath)).toEqual({
      ...DEFAULT_PROXY_VALUES,
    })
  })

  it("merges into existing file, preserving other keys", () => {
    writeRaw(
      JSON.stringify({ mcpServers: { x: { command: "y" } }, theme: "dark" }),
    )
    const result = applyProxyConfig(configPath)
    expect(result.wrote).toBe(true)
    expect(result.preservedKeys.sort()).toEqual(["mcpServers", "theme"])
    const after = readClaudeDesktopConfig(configPath)
    expect(after.mcpServers).toEqual({ x: { command: "y" } })
    expect(after.theme).toBe("dark")
    expect(after.inferenceProvider).toBe("gateway")
  })

  it("skips write when already configured", () => {
    writeClaudeDesktopConfig(configPath, {
      ...DEFAULT_PROXY_VALUES,
      mcpServers: { x: 1 },
    })
    const before = fs.statSync(configPath).mtimeMs
    // Force a small delay so mtime would change if write happened
    const result = applyProxyConfig(configPath)
    expect(result.wrote).toBe(false)
    expect(result.preservedKeys).toEqual(["mcpServers"])
    const after = fs.statSync(configPath).mtimeMs
    expect(after).toBe(before)
  })
})

describe("revertProxyConfig", () => {
  it("no-op when our keys aren't present", () => {
    writeRaw(JSON.stringify({ theme: "dark" }))
    const result = revertProxyConfig(configPath)
    expect(result.wrote).toBe(false)
    expect(result.remainingKeys).toEqual(["theme"])
    expect(readClaudeDesktopConfig(configPath)).toEqual({ theme: "dark" })
  })

  it("strips our keys, preserves user keys", () => {
    writeClaudeDesktopConfig(configPath, {
      ...DEFAULT_PROXY_VALUES,
      mcpServers: { x: 1 },
    })
    const result = revertProxyConfig(configPath)
    expect(result.wrote).toBe(true)
    expect(result.remainingKeys).toEqual(["mcpServers"])
    expect(readClaudeDesktopConfig(configPath)).toEqual({
      mcpServers: { x: 1 },
    })
  })

  it("removes file entirely when nothing else remains", () => {
    writeClaudeDesktopConfig(configPath, { ...DEFAULT_PROXY_VALUES })
    const result = revertProxyConfig(configPath)
    expect(result.wrote).toBe(true)
    expect(result.remainingKeys).toEqual([])
    expect(fs.existsSync(configPath)).toBe(false)
  })

  it("no-op on absent file", () => {
    const result = revertProxyConfig(configPath)
    expect(result.wrote).toBe(false)
    expect(result.remainingKeys).toEqual([])
  })
})
