import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  alreadyConfigured,
  applyProxyConfig,
  defaultProxyValues,
  mergeProxyKeys,
  PROXY_KEYS,
  readClaudeDesktopConfig,
  revertProxyConfig,
  stripProxyKeys,
  writeClaudeDesktopConfig,
} from "~/lib/claude-desktop-config"

const TMP_ROOT = path.join(os.tmpdir(), `claude-config-test-${Date.now()}`)
let dir: string
let configPath: string
let fakeHome: string
let values: ReturnType<typeof defaultProxyValues>

beforeEach(() => {
  dir = path.join(TMP_ROOT, `case-${crypto.randomUUID()}`)
  fs.mkdirSync(dir, { recursive: true })
  configPath = path.join(dir, "claude_desktop_config.json")
  fakeHome = path.join(dir, "home")
  fs.mkdirSync(fakeHome, { recursive: true })
  values = defaultProxyValues(fakeHome)
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

describe("defaultProxyValues", () => {
  it("parameterizes allowedWorkspaceFolders by $HOME", () => {
    expect(values.allowedWorkspaceFolders).toEqual([
      path.join(fakeHome, "Claude"),
    ])
  })

  it("matches the Claude Desktop default profile", () => {
    expect(values.inferenceProvider).toBe("gateway")
    expect(values.inferenceGatewayBaseUrl).toBe("http://127.0.0.1:4141")
    expect(values.inferenceGatewayAuthScheme).toBe("bearer")
    expect(values.coworkEgressAllowedHosts).toEqual(["*"])
    expect(values.disableEssentialTelemetry).toBe(true)
    expect(values.disableNonessentialTelemetry).toBe(true)
    expect(values.isLocalDevMcpEnabled).toBe(true)
  })
})

describe("readClaudeDesktopConfig", () => {
  it("returns {} when the file is absent", () => {
    expect(readClaudeDesktopConfig(configPath)).toEqual({})
  })

  it("returns {} for empty / malformed / non-object JSON", () => {
    writeRaw("")
    expect(readClaudeDesktopConfig(configPath)).toEqual({})
    writeRaw("{ not valid json")
    expect(readClaudeDesktopConfig(configPath)).toEqual({})
    writeRaw("[]")
    expect(readClaudeDesktopConfig(configPath)).toEqual({})
  })

  it("parses a valid config", () => {
    writeRaw(JSON.stringify({ foo: "bar", n: 1 }))
    expect(readClaudeDesktopConfig(configPath)).toEqual({ foo: "bar", n: 1 })
  })
})

describe("mergeProxyKeys / stripProxyKeys / alreadyConfigured", () => {
  it("merge sets every owned key, preserves others", () => {
    const merged = mergeProxyKeys(
      {
        existingUserKey: "left alone",
        mcpServers: { foo: { command: "bar" } },
      },
      values,
    )
    expect(merged.existingUserKey).toBe("left alone")
    expect(merged.mcpServers).toEqual({ foo: { command: "bar" } })
    for (const k of PROXY_KEYS) {
      expect(merged[k]).toEqual(values[k])
    }
  })

  it("merge overwrites a stale proxy value", () => {
    const merged = mergeProxyKeys(
      {
        inferenceProvider: "vertex",
        coworkEgressAllowedHosts: ["github.com"],
      },
      values,
    )
    expect(merged.inferenceProvider).toBe("gateway")
    expect(merged.coworkEgressAllowedHosts).toEqual(["*"])
  })

  it("strip removes every owned key, preserves user keys", () => {
    const stripped = stripProxyKeys({
      ...(values as unknown as Record<string, unknown>),
      myCustomKey: "stays",
      mcpServers: { x: 1 },
    })
    expect(stripped).toEqual({ myCustomKey: "stays", mcpServers: { x: 1 } })
  })

  it("alreadyConfigured deep-compares arrays", () => {
    const matching = { ...(values as unknown as Record<string, unknown>) }
    expect(alreadyConfigured(matching, values)).toBe(true)
    expect(alreadyConfigured({ ...matching, otherKey: 1 }, values)).toBe(true)
    expect(
      alreadyConfigured(
        { ...matching, coworkEgressAllowedHosts: ["github.com"] },
        values,
      ),
    ).toBe(false)
    expect(
      alreadyConfigured(
        { ...matching, allowedWorkspaceFolders: ["/elsewhere"] },
        values,
      ),
    ).toBe(false)
    expect(alreadyConfigured({}, values)).toBe(false)
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

  it("writes JSON with trailing newline and no .tmp leak", () => {
    writeClaudeDesktopConfig(configPath, { foo: 1 })
    const raw = fs.readFileSync(configPath, "utf8")
    expect(raw.endsWith("\n")).toBe(true)
    expect(JSON.parse(raw)).toEqual({ foo: 1 })
    expect(fs.existsSync(`${configPath}.tmp`)).toBe(false)
  })
})

describe("applyProxyConfig (end-to-end)", () => {
  it("creates the file with our keys when absent", () => {
    const result = applyProxyConfig(configPath, values)
    expect(result.wrote).toBe(true)
    expect(result.preservedKeys).toEqual([])
    const after = readClaudeDesktopConfig(configPath)
    for (const k of PROXY_KEYS) {
      expect(after[k]).toEqual(values[k])
    }
  })

  it("merges into existing file, preserving other keys", () => {
    writeRaw(
      JSON.stringify({ mcpServers: { x: { command: "y" } }, theme: "dark" }),
    )
    const result = applyProxyConfig(configPath, values)
    expect(result.wrote).toBe(true)
    expect(result.preservedKeys.sort()).toEqual(["mcpServers", "theme"])
    const after = readClaudeDesktopConfig(configPath)
    expect(after.mcpServers).toEqual({ x: { command: "y" } })
    expect(after.theme).toBe("dark")
    expect(after.inferenceProvider).toBe("gateway")
  })

  it("creates allowedWorkspaceFolders directories if missing", () => {
    const result = applyProxyConfig(configPath, values)
    const expected = path.join(fakeHome, "Claude")
    expect(result.ensuredWorkspaceFolders).toContain(expected)
    expect(fs.existsSync(expected)).toBe(true)
    expect(fs.statSync(expected).isDirectory()).toBe(true)
  })

  it("skips write when already configured", () => {
    writeClaudeDesktopConfig(configPath, {
      ...(values as unknown as Record<string, unknown>),
      mcpServers: { x: 1 },
    })
    const before = fs.statSync(configPath).mtimeMs
    const result = applyProxyConfig(configPath, values)
    expect(result.wrote).toBe(false)
    expect(result.preservedKeys).toEqual(["mcpServers"])
    expect(fs.statSync(configPath).mtimeMs).toBe(before)
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
      ...(values as unknown as Record<string, unknown>),
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
    writeClaudeDesktopConfig(
      configPath,
      values as unknown as Record<string, unknown>,
    )
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
