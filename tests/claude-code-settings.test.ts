import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  API_KEY_HELPER_COMMAND,
  applyProxyBaseUrl,
  getApiKeyHelperOwnership,
  getBaseUrlOwnership,
  getClaudeCodeSettingsPath,
  isProxyBaseUrlConfigured,
  mergeBaseUrl,
  PROXY_BASE_URL,
  readClaudeCodeSettings,
  revertProxyBaseUrl,
  stripBaseUrl,
  writeClaudeCodeSettings,
} from "~/apps/claude-code/config"

let dir: string
let settingsPath: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-claude-code-"))
  settingsPath = path.join(dir, "settings.json")
})

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

function writeRaw(value: string): void {
  fs.writeFileSync(settingsPath, value)
}

function read(): Record<string, unknown> {
  return readClaudeCodeSettings(settingsPath)
}

function envOf(settings: Record<string, unknown>): Record<string, unknown> {
  return settings.env as Record<string, unknown>
}

describe("getClaudeCodeSettingsPath", () => {
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR

  afterEach(() => {
    if (savedConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    }
  })

  it("defaults to ~/.claude/settings.json", () => {
    delete process.env.CLAUDE_CONFIG_DIR
    expect(getClaudeCodeSettingsPath()).toBe(
      path.join(os.homedir(), ".claude", "settings.json"),
    )
  })

  it("honors CLAUDE_CONFIG_DIR override", () => {
    process.env.CLAUDE_CONFIG_DIR = "/custom/claude/dir"
    expect(getClaudeCodeSettingsPath()).toBe(
      path.join("/custom/claude/dir", "settings.json"),
    )
  })
})

describe("readClaudeCodeSettings", () => {
  it("returns {} when the file is absent", () => {
    expect(read()).toEqual({})
  })

  it("returns {} for empty / malformed / non-object JSON", () => {
    writeRaw("")
    expect(read()).toEqual({})
    writeRaw("{ not valid json")
    expect(read()).toEqual({})
    writeRaw("[]")
    expect(read()).toEqual({})
  })

  it("parses a valid settings object", () => {
    writeRaw(JSON.stringify({ theme: "dark", env: { FOO: "1" } }))
    expect(read()).toEqual({ theme: "dark", env: { FOO: "1" } })
  })
})

describe("getBaseUrlOwnership", () => {
  it("absent when no env / no key", () => {
    expect(getBaseUrlOwnership({})).toBe("absent")
    expect(getBaseUrlOwnership({ env: {} })).toBe("absent")
    expect(getBaseUrlOwnership({ env: { FOO: "1" } })).toBe("absent")
    // non-object env is treated as absent
    expect(getBaseUrlOwnership({ env: "nope" })).toBe("absent")
  })

  it("ours when it equals the proxy URL", () => {
    expect(
      getBaseUrlOwnership({ env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL } }),
    ).toBe("ours")
  })

  it("foreign when it is some other value", () => {
    expect(
      getBaseUrlOwnership({
        env: { ANTHROPIC_BASE_URL: "https://other.example" },
      }),
    ).toBe("foreign")
  })
})

describe("getApiKeyHelperOwnership", () => {
  it("absent when no apiKeyHelper is configured", () => {
    expect(getApiKeyHelperOwnership({})).toBe("absent")
  })

  it("ours when it equals maximal's helper command", () => {
    expect(
      getApiKeyHelperOwnership({ apiKeyHelper: API_KEY_HELPER_COMMAND }),
    ).toBe("ours")
  })

  it("foreign when it is some other value", () => {
    expect(getApiKeyHelperOwnership({ apiKeyHelper: "other-helper" })).toBe(
      "foreign",
    )
  })
})

describe("mergeBaseUrl / stripBaseUrl (pure)", () => {
  it("merge sets env.ANTHROPIC_BASE_URL and apiKeyHelper, preserves existing settings", () => {
    const merged = mergeBaseUrl({
      theme: "dark",
      env: { FOO: "1", ANTHROPIC_API_KEY: "sk-secret" },
    })
    expect(merged.theme).toBe("dark")
    expect(merged.apiKeyHelper).toBe(API_KEY_HELPER_COMMAND)
    expect(envOf(merged)).toEqual({
      FOO: "1",
      ANTHROPIC_API_KEY: "sk-secret",
      ANTHROPIC_BASE_URL: PROXY_BASE_URL,
    })
  })

  it("merge creates env when absent", () => {
    const merged = mergeBaseUrl({ theme: "dark" })
    expect(merged.theme).toBe("dark")
    expect(envOf(merged)).toEqual({ ANTHROPIC_BASE_URL: PROXY_BASE_URL })
    expect(merged.apiKeyHelper).toBe(API_KEY_HELPER_COMMAND)
  })

  it("merge does not mutate the input", () => {
    const input = { env: { FOO: "1" } }
    mergeBaseUrl(input)
    expect(input).toEqual({ env: { FOO: "1" } })
  })

  it("strip removes only our keys, preserves sibling env + top-level", () => {
    const stripped = stripBaseUrl({
      theme: "dark",
      apiKeyHelper: API_KEY_HELPER_COMMAND,
      env: {
        ANTHROPIC_BASE_URL: PROXY_BASE_URL,
        ANTHROPIC_API_KEY: "sk-secret",
      },
    })
    expect(stripped).toEqual({
      theme: "dark",
      env: { ANTHROPIC_API_KEY: "sk-secret" },
    })
  })

  it("strip preserves a foreign apiKeyHelper and foreign base URL", () => {
    const stripped = stripBaseUrl({
      apiKeyHelper: "other-helper",
      env: { ANTHROPIC_BASE_URL: "https://other.example" },
    })
    expect(stripped).toEqual({
      apiKeyHelper: "other-helper",
      env: { ANTHROPIC_BASE_URL: "https://other.example" },
    })
  })

  it("strip drops the env key when it becomes empty", () => {
    const stripped = stripBaseUrl({
      theme: "dark",
      apiKeyHelper: API_KEY_HELPER_COMMAND,
      env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL },
    })
    expect(stripped).toEqual({ theme: "dark" })
    expect("env" in stripped).toBe(false)
  })
})

describe("writeClaudeCodeSettings", () => {
  it("creates parent directory if missing", () => {
    const nested = path.join(dir, "a", "b", "settings.json")
    writeClaudeCodeSettings(nested, { foo: "bar" })
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer
    expect(JSON.parse(fs.readFileSync(nested, "utf8"))).toEqual({ foo: "bar" })
  })

  it("writes JSON with trailing newline and no .tmp leak", () => {
    writeClaudeCodeSettings(settingsPath, { foo: 1 })
    const raw = fs.readFileSync(settingsPath, "utf8")
    expect(raw.endsWith("\n")).toBe(true)
    expect(JSON.parse(raw)).toEqual({ foo: 1 })
    expect(fs.existsSync(`${settingsPath}.tmp`)).toBe(false)
  })

  it("writes with mode 0600", () => {
    writeClaudeCodeSettings(settingsPath, { foo: 1 })
    const mode = fs.statSync(settingsPath).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe("applyProxyBaseUrl (end-to-end)", () => {
  it("writes env.ANTHROPIC_BASE_URL into a fresh file", () => {
    const result = applyProxyBaseUrl(settingsPath)
    expect(result.wrote).toBe(true)
    expect(result.skippedReason).toBeUndefined()
    expect(envOf(read()).ANTHROPIC_BASE_URL).toBe(PROXY_BASE_URL)
    expect(read().apiKeyHelper).toBe(API_KEY_HELPER_COMMAND)
  })

  it("preserves a pre-existing top-level setting and sibling env vars", () => {
    writeRaw(
      JSON.stringify({
        theme: "dark",
        permissions: { allow: ["Bash"] },
        env: { FOO: "1", ANTHROPIC_API_KEY: "sk-secret" },
      }),
    )
    const result = applyProxyBaseUrl(settingsPath)
    expect(result.wrote).toBe(true)
    const after = read()
    expect(after.theme).toBe("dark")
    expect(after.permissions).toEqual({ allow: ["Bash"] })
    expect(after.apiKeyHelper).toBe(API_KEY_HELPER_COMMAND)
    expect(envOf(after)).toEqual({
      FOO: "1",
      ANTHROPIC_API_KEY: "sk-secret",
      ANTHROPIC_BASE_URL: PROXY_BASE_URL,
    })
  })

  it("ownership guard: does NOT overwrite a foreign base URL", () => {
    const original = {
      env: { ANTHROPIC_BASE_URL: "https://other.example", FOO: "1" },
    }
    writeRaw(JSON.stringify(original))
    const before = fs.statSync(settingsPath).mtimeMs
    const result = applyProxyBaseUrl(settingsPath)
    expect(result.wrote).toBe(false)
    expect(result.skippedReason).toBe("foreign-base-url")
    // file unchanged
    expect(read()).toEqual(original)
    expect(fs.statSync(settingsPath).mtimeMs).toBe(before)
  })

  it("idempotent: applying twice is a no-op the second time", () => {
    const first = applyProxyBaseUrl(settingsPath)
    expect(first.wrote).toBe(true)
    const before = fs.statSync(settingsPath).mtimeMs
    const second = applyProxyBaseUrl(settingsPath)
    expect(second.wrote).toBe(false)
    expect(second.skippedReason).toBe("already-ours")
    expect(fs.statSync(settingsPath).mtimeMs).toBe(before)
    // no duplication
    expect(envOf(read())).toEqual({ ANTHROPIC_BASE_URL: PROXY_BASE_URL })
    expect(read().apiKeyHelper).toBe(API_KEY_HELPER_COMMAND)
  })

  it("handles an absent file (writes fresh)", () => {
    expect(fs.existsSync(settingsPath)).toBe(false)
    const result = applyProxyBaseUrl(settingsPath)
    expect(result.wrote).toBe(true)
    expect(read()).toEqual({
      apiKeyHelper: API_KEY_HELPER_COMMAND,
      env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL },
      // Snapshot of the prior state: both fields were absent → UNSET, so a later
      // disable removes them (returns the file to nothing).
      _maximalPrior: {
        ANTHROPIC_BASE_URL: "__UNSET__",
        apiKeyHelper: "__UNSET__",
      },
    })
  })

  it("handles an unparseable file (writes fresh)", () => {
    writeRaw("{ garbage")
    const result = applyProxyBaseUrl(settingsPath)
    expect(result.wrote).toBe(true)
    expect(read()).toEqual({
      apiKeyHelper: API_KEY_HELPER_COMMAND,
      env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL },
      _maximalPrior: {
        ANTHROPIC_BASE_URL: "__UNSET__",
        apiKeyHelper: "__UNSET__",
      },
    })
  })

  it("ownership guard: does NOT overwrite a foreign apiKeyHelper", () => {
    const original = { apiKeyHelper: "other-helper" }
    writeRaw(JSON.stringify(original))
    const result = applyProxyBaseUrl(settingsPath)
    expect(result.wrote).toBe(false)
    expect(result.skippedReason).toBe("foreign-api-key-helper")
    expect(read()).toEqual(original)
  })
})

describe("revertProxyBaseUrl", () => {
  it("removes only our key, preserves sibling env + other settings", () => {
    writeRaw(
      JSON.stringify({
        theme: "dark",
        apiKeyHelper: API_KEY_HELPER_COMMAND,
        env: {
          ANTHROPIC_BASE_URL: PROXY_BASE_URL,
          ANTHROPIC_API_KEY: "sk-secret",
        },
      }),
    )
    const result = revertProxyBaseUrl(settingsPath)
    expect(result.wrote).toBe(true)
    expect(result.remainingKeys.sort()).toEqual(["env", "theme"])
    expect(read()).toEqual({
      theme: "dark",
      env: { ANTHROPIC_API_KEY: "sk-secret" },
    })
  })

  it("drops the empty env key but keeps other settings", () => {
    writeRaw(
      JSON.stringify({
        theme: "dark",
        apiKeyHelper: API_KEY_HELPER_COMMAND,
        env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL },
      }),
    )
    const result = revertProxyBaseUrl(settingsPath)
    expect(result.wrote).toBe(true)
    expect(result.remainingKeys).toEqual(["theme"])
    expect(read()).toEqual({ theme: "dark" })
  })

  it("deletes the file when it becomes empty", () => {
    writeRaw(
      JSON.stringify({
        apiKeyHelper: API_KEY_HELPER_COMMAND,
        env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL },
      }),
    )
    const result = revertProxyBaseUrl(settingsPath)
    expect(result.wrote).toBe(true)
    expect(result.remainingKeys).toEqual([])
    expect(fs.existsSync(settingsPath)).toBe(false)
  })

  it("leaves a foreign base URL intact", () => {
    const original = {
      env: { ANTHROPIC_BASE_URL: "https://other.example" },
    }
    writeRaw(JSON.stringify(original))
    const result = revertProxyBaseUrl(settingsPath)
    expect(result.wrote).toBe(false)
    expect(read()).toEqual(original)
  })

  it("removes our apiKeyHelper even when the base URL is absent", () => {
    writeRaw(JSON.stringify({ apiKeyHelper: API_KEY_HELPER_COMMAND }))
    const result = revertProxyBaseUrl(settingsPath)
    expect(result.wrote).toBe(true)
    expect(result.remainingKeys).toEqual([])
    expect(fs.existsSync(settingsPath)).toBe(false)
  })

  it("no-op on an absent file", () => {
    const result = revertProxyBaseUrl(settingsPath)
    expect(result.wrote).toBe(false)
    expect(result.remainingKeys).toEqual([])
  })

  it("no-op when our key isn't present", () => {
    writeRaw(JSON.stringify({ theme: "dark", env: { FOO: "1" } }))
    const result = revertProxyBaseUrl(settingsPath)
    expect(result.wrote).toBe(false)
    expect(result.remainingKeys.sort()).toEqual(["env", "theme"])
    expect(read()).toEqual({ theme: "dark", env: { FOO: "1" } })
  })
})

describe("apply→revert snapshot round-trip (restores prior state)", () => {
  it("absent → enable → disable returns the file to nothing", () => {
    applyProxyBaseUrl(settingsPath)
    revertProxyBaseUrl(settingsPath)
    // Nothing was there before, so disable removes everything (file gone).
    expect(fs.existsSync(settingsPath)).toBe(false)
  })

  it("restores a user's OWN ANTHROPIC_BASE_URL that equals the proxy URL", () => {
    // The coincidence trap: the user had set the proxy URL themselves. Ownership
    // reads "ours", but a blind delete would drop THEIR value. The snapshot makes
    // disable restore it exactly.
    writeRaw(JSON.stringify({ env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL } }))
    applyProxyBaseUrl(settingsPath)
    revertProxyBaseUrl(settingsPath)
    expect(read()).toEqual({ env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL } })
  })

  it("restores a user's own apiKeyHelper that matches our signature", () => {
    // A pre-existing helper that happens to carry our --apiKeyHelper claude-code
    // signature (e.g. an older maximal path) is captured and restored verbatim.
    const userHelper = '"/old/maximal" --apiKeyHelper claude-code'
    writeRaw(JSON.stringify({ apiKeyHelper: userHelper }))
    applyProxyBaseUrl(settingsPath)
    revertProxyBaseUrl(settingsPath)
    expect(read()).toEqual({ apiKeyHelper: userHelper })
  })

  it("preserves unrelated settings + sibling env across the round-trip", () => {
    const before = {
      theme: "dark",
      permissions: { allow: ["Bash"] },
      env: { FOO: "1", ANTHROPIC_API_KEY: "sk-secret" },
    }
    writeRaw(JSON.stringify(before))
    applyProxyBaseUrl(settingsPath)
    revertProxyBaseUrl(settingsPath)
    expect(read()).toEqual(before)
  })

  it("re-apply (self-heal) does not poison the snapshot", () => {
    // The execPath self-heal re-runs applyProxyBaseUrl. It must NOT capture our
    // own values as the prior state, or disable would restore the proxy URL.
    applyProxyBaseUrl(settingsPath)
    applyProxyBaseUrl(settingsPath) // self-heal / re-apply
    revertProxyBaseUrl(settingsPath)
    expect(fs.existsSync(settingsPath)).toBe(false)
  })
})

describe("isProxyBaseUrlConfigured", () => {
  it("true only when env.ANTHROPIC_BASE_URL is our proxy URL", () => {
    expect(isProxyBaseUrlConfigured(settingsPath)).toBe(false)
    writeRaw(JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://other" } }))
    expect(isProxyBaseUrlConfigured(settingsPath)).toBe(false)
    applyProxyBaseUrl(settingsPath)
    // foreign URL present, so apply backed off — still not ours
    expect(isProxyBaseUrlConfigured(settingsPath)).toBe(false)
    // now make it ours
    writeRaw(
      JSON.stringify({
        apiKeyHelper: API_KEY_HELPER_COMMAND,
        env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL },
      }),
    )
    expect(isProxyBaseUrlConfigured(settingsPath)).toBe(true)
  })
})
