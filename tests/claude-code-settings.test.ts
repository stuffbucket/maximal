import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
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
import { getConfig, writeConfig } from "~/lib/config/config"

const TEST_KEY = "custom-user-key"
const TEST_HELPER = "echo 'custom-user-key'"
const AUTO_MODE_SERVER_KEY = "CLAUDE_CODE_AUTO_MODE_SERVER"
const TEST_MARKER = {
  label: "claude-code",
  strategy: "echo",
  fingerprint:
    "16ba58604080f664b043e3c4858ff452390db3db7d109225b13d482337657782",
}
const resolveTestKey = () =>
  ({ ok: true, key: TEST_KEY, source: "app" }) as const

let dir: string
let settingsPath: string

beforeEach(() => {
  writeConfig({})
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-claude-code-"))
  settingsPath = path.join(dir, "settings.json")
})

afterEach(() => {
  writeConfig({})
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

function apply() {
  return applyProxyBaseUrl(settingsPath, resolveTestKey)
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
    expect(PROXY_BASE_URL).toBe("http://127.0.0.1:4141")
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
  const command = TEST_HELPER
  const marker = TEST_MARKER

  it("absent when no apiKeyHelper is configured", () => {
    expect(getApiKeyHelperOwnership({})).toBe("absent")
  })

  it("ours when the marker fingerprints the exact echo helper", () => {
    expect(
      getApiKeyHelperOwnership({
        apiKeyHelper: command,
        _maximalHelper: marker,
      }),
    ).toBe("ours")
  })

  it("foreign when a marked helper was edited after maximal wrote it", () => {
    expect(
      getApiKeyHelperOwnership({
        apiKeyHelper: "echo 'changed-by-user'",
        _maximalHelper: marker,
      }),
    ).toBe("foreign")
  })

  it("foreign when a marker has the wrong label or strategy", () => {
    expect(
      getApiKeyHelperOwnership({
        apiKeyHelper: command,
        _maximalHelper: { ...marker, label: "other-client" },
      }),
    ).toBe("foreign")
    expect(
      getApiKeyHelperOwnership({
        apiKeyHelper: command,
        _maximalHelper: { ...marker, strategy: "binary" },
      }),
    ).toBe("foreign")
  })

  it("foreign when marker or command types are malformed", () => {
    for (const malformed of [
      null,
      [],
      "maximal",
      42,
      Object.assign(() => undefined, marker),
    ]) {
      expect(
        getApiKeyHelperOwnership({
          apiKeyHelper: command,
          _maximalHelper: malformed,
        }),
      ).toBe("foreign")
    }
    expect(
      getApiKeyHelperOwnership({
        apiKeyHelper: 42,
        _maximalHelper: marker,
      }),
    ).toBe("foreign")
  })

  it("recognizes a legacy maximal command when no marker exists", () => {
    expect(
      getApiKeyHelperOwnership({
        apiKeyHelper:
          '"/opt/homebrew/Cellar/maximal/0.4.41/bin/maximal" api claude-code',
      }),
    ).toBe("ours")
  })

  it("foreign when an unmarked echo helper is configured", () => {
    expect(getApiKeyHelperOwnership({ apiKeyHelper: command })).toBe("foreign")
  })
})

describe("mergeBaseUrl / stripBaseUrl (pure)", () => {
  it("merge sets the echo helper and its exact ownership fingerprint", () => {
    const merged = mergeBaseUrl(
      {
        theme: "dark",
        env: { FOO: "1", ANTHROPIC_API_KEY: "sk-secret" },
      },
      "echo 'custom-user-key'",
    )
    expect(merged.theme).toBe("dark")
    expect(merged.apiKeyHelper).toBe("echo 'custom-user-key'")
    expect(merged._maximalHelper).toEqual({
      label: "claude-code",
      strategy: "echo",
      fingerprint:
        "16ba58604080f664b043e3c4858ff452390db3db7d109225b13d482337657782",
    })
    expect(envOf(merged)).toEqual({
      FOO: "1",
      ANTHROPIC_API_KEY: "sk-secret",
      ANTHROPIC_BASE_URL: PROXY_BASE_URL,
      [AUTO_MODE_SERVER_KEY]: "0",
    })
  })

  it("merge creates env when absent", () => {
    const merged = mergeBaseUrl({ theme: "dark" }, TEST_HELPER)
    expect(merged.theme).toBe("dark")
    expect(envOf(merged)).toEqual({
      ANTHROPIC_BASE_URL: PROXY_BASE_URL,
      [AUTO_MODE_SERVER_KEY]: "0",
    })
    expect(merged.apiKeyHelper).toBe(TEST_HELPER)
  })

  it("merge does not mutate the input", () => {
    const input = { env: { FOO: "1" } }
    mergeBaseUrl(input, TEST_HELPER)
    expect(input).toEqual({ env: { FOO: "1" } })
  })

  it("strip removes only our keys, preserves sibling env + top-level", () => {
    const stripped = stripBaseUrl({
      theme: "dark",
      apiKeyHelper: TEST_HELPER,
      _maximalHelper: TEST_MARKER,
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
      apiKeyHelper: TEST_HELPER,
      _maximalHelper: TEST_MARKER,
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
    const result = apply()
    expect(result.wrote).toBe(true)
    expect(result.skippedReason).toBeUndefined()
    expect(envOf(read()).ANTHROPIC_BASE_URL).toBe(PROXY_BASE_URL)
    expect(envOf(read())[AUTO_MODE_SERVER_KEY]).toBe("0")
    expect(read().apiKeyHelper).toBe(TEST_HELPER)
  })

  it("preserves a pre-existing top-level setting and sibling env vars", () => {
    writeRaw(
      JSON.stringify({
        theme: "dark",
        permissions: { allow: ["Bash"] },
        env: { FOO: "1", ANTHROPIC_API_KEY: "sk-secret" },
      }),
    )
    const result = apply()
    expect(result.wrote).toBe(true)
    const after = read()
    expect(after.theme).toBe("dark")
    expect(after.permissions).toEqual({ allow: ["Bash"] })
    expect(after.apiKeyHelper).toBe(TEST_HELPER)
    expect(envOf(after)).toEqual({
      FOO: "1",
      ANTHROPIC_API_KEY: "sk-secret",
      ANTHROPIC_BASE_URL: PROXY_BASE_URL,
      [AUTO_MODE_SERVER_KEY]: "0",
    })
  })

  it("ownership guard: does NOT overwrite a foreign base URL", () => {
    const original = {
      env: { ANTHROPIC_BASE_URL: "https://other.example", FOO: "1" },
    }
    writeRaw(JSON.stringify(original))
    const before = fs.statSync(settingsPath).mtimeMs
    const result = apply()
    expect(result.wrote).toBe(false)
    expect(result.skippedReason).toBe("foreign-base-url")
    // file unchanged
    expect(read()).toEqual(original)
    expect(fs.statSync(settingsPath).mtimeMs).toBe(before)
  })

  it("idempotent: applying twice is a no-op the second time", () => {
    const first = apply()
    expect(first.wrote).toBe(true)
    const before = fs.statSync(settingsPath).mtimeMs
    const second = apply()
    expect(second.wrote).toBe(false)
    expect(second.skippedReason).toBe("already-ours")
    expect(fs.statSync(settingsPath).mtimeMs).toBe(before)
    // no duplication
    expect(envOf(read())).toEqual({
      ANTHROPIC_BASE_URL: PROXY_BASE_URL,
      [AUTO_MODE_SERVER_KEY]: "0",
    })
    expect(read().apiKeyHelper).toBe(TEST_HELPER)
  })

  it("fills in an absent helper when the base URL is already ours", () => {
    writeRaw(JSON.stringify({ env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL } }))

    const result = apply()

    expect(result.wrote).toBe(true)
    expect(isProxyBaseUrlConfigured(settingsPath)).toBe(true)
  })

  it("fills in an absent base URL when the marked helper is already ours", () => {
    writeRaw(
      JSON.stringify({
        apiKeyHelper: TEST_HELPER,
        _maximalHelper: TEST_MARKER,
      }),
    )

    const result = apply()

    expect(result.wrote).toBe(true)
    expect(isProxyBaseUrlConfigured(settingsPath)).toBe(true)
  })
})

describe("applyProxyBaseUrl classifier setting", () => {
  for (const existingValue of ["0", "1"] as const) {
    it(`preserves a user-owned ${AUTO_MODE_SERVER_KEY}=${existingValue}`, () => {
      const original = {
        env: { [AUTO_MODE_SERVER_KEY]: existingValue },
      }
      writeRaw(JSON.stringify(original))

      apply()
      expect(envOf(read())[AUTO_MODE_SERVER_KEY]).toBe(existingValue)

      revertProxyBaseUrl(settingsPath)
      expect(read()).toEqual(original)
    })
  }

  it("preserves a classifier setting edited after enable", () => {
    apply()
    const edited = read()
    writeRaw(
      JSON.stringify({
        ...edited,
        env: { ...envOf(edited), [AUTO_MODE_SERVER_KEY]: "1" },
      }),
    )

    revertProxyBaseUrl(settingsPath)

    expect(read()).toEqual({ env: { [AUTO_MODE_SERVER_KEY]: "1" } })
  })

  it("adopts an absent classifier setting from a legacy snapshot", () => {
    writeRaw(
      JSON.stringify({
        apiKeyHelper: TEST_HELPER,
        _maximalHelper: TEST_MARKER,
        env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL },
        _maximalPrior: {
          ANTHROPIC_BASE_URL: "__UNSET__",
          apiKeyHelper: "__UNSET__",
        },
      }),
    )

    apply()
    expect(envOf(read())[AUTO_MODE_SERVER_KEY]).toBe("0")

    revertProxyBaseUrl(settingsPath)
    expect(fs.existsSync(settingsPath)).toBe(false)
  })

  it("does not adopt a classifier value from a legacy snapshot", () => {
    const original = {
      apiKeyHelper: TEST_HELPER,
      _maximalHelper: TEST_MARKER,
      env: {
        ANTHROPIC_BASE_URL: PROXY_BASE_URL,
        [AUTO_MODE_SERVER_KEY]: "0",
      },
      _maximalPrior: {
        ANTHROPIC_BASE_URL: "__UNSET__",
        apiKeyHelper: "__UNSET__",
      },
    }
    writeRaw(JSON.stringify(original))

    const result = apply()
    expect(result.skippedReason).toBe("already-ours")

    revertProxyBaseUrl(settingsPath)
    expect(read()).toEqual({ env: { [AUTO_MODE_SERVER_KEY]: "0" } })
  })
})

describe("applyProxyBaseUrl (end-to-end continued)", () => {
  it("handles an absent file (writes fresh)", () => {
    expect(fs.existsSync(settingsPath)).toBe(false)
    const result = apply()
    expect(result.wrote).toBe(true)
    expect(read()).toEqual({
      apiKeyHelper: TEST_HELPER,
      _maximalHelper: TEST_MARKER,
      env: {
        ANTHROPIC_BASE_URL: PROXY_BASE_URL,
        [AUTO_MODE_SERVER_KEY]: "0",
      },
      _maximalPrior: {
        ANTHROPIC_BASE_URL: "__UNSET__",
        apiKeyHelper: "__UNSET__",
        [AUTO_MODE_SERVER_KEY]: "__UNSET__",
      },
    })
  })

  it("handles an unparseable file (writes fresh)", () => {
    writeRaw("{ garbage")
    const result = apply()
    expect(result.wrote).toBe(true)
    expect(read()).toEqual({
      apiKeyHelper: TEST_HELPER,
      _maximalHelper: TEST_MARKER,
      env: {
        ANTHROPIC_BASE_URL: PROXY_BASE_URL,
        [AUTO_MODE_SERVER_KEY]: "0",
      },
      _maximalPrior: {
        ANTHROPIC_BASE_URL: "__UNSET__",
        apiKeyHelper: "__UNSET__",
        [AUTO_MODE_SERVER_KEY]: "__UNSET__",
      },
    })
  })

  for (const [name, legacyHelper] of [
    [
      "v0.4.41 Cellar",
      '"/opt/homebrew/Cellar/maximal/0.4.41/bin/maximal" api claude-code',
    ],
    [
      "application bundle",
      '"/Applications/Maximal.app/Contents/MacOS/maximal" api claude-code',
    ],
    [
      "runtime",
      '"/Users/test/.bun/bin/bun" "/Users/test/maximal/src/main.ts" api claude-code',
    ],
    ["legacy flag", "maximal --apiKeyHelper claude-code"],
  ] as const) {
    it(`migrates a ${name} helper to the echo strategy`, () => {
      writeRaw(
        JSON.stringify({
          apiKeyHelper: legacyHelper,
          env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL },
        }),
      )

      const result = apply()

      expect(result.wrote).toBe(true)
      expect(read().apiKeyHelper).toBe(TEST_HELPER)
      expect(getApiKeyHelperOwnership(read())).toBe("ours")
    })
  }

  it("disables cleanly after migrating an enabled v0.4.41 configuration", () => {
    writeRaw(
      JSON.stringify({
        apiKeyHelper:
          '"/opt/homebrew/Cellar/maximal/0.4.41/bin/maximal" api claude-code',
        env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL },
      }),
    )

    apply()
    revertProxyBaseUrl(settingsPath)

    expect(fs.existsSync(settingsPath)).toBe(false)
  })

  it("updates an owned echo helper when the configured key rotates", () => {
    apply()
    const prior = read()._maximalPrior

    const result = applyProxyBaseUrl(settingsPath, () => ({
      ok: true,
      key: "rotated-user-key",
      source: "app",
    }))

    expect(result.wrote).toBe(true)
    expect(read().apiKeyHelper).toBe("echo 'rotated-user-key'")
    expect(read()._maximalPrior).toEqual(prior)
    expect(getApiKeyHelperOwnership(read())).toBe("ours")
  })

  it("does not change settings when no API key can be resolved", () => {
    const original = {
      apiKeyHelper:
        '"/opt/homebrew/Cellar/maximal/0.4.41/bin/maximal" api claude-code',
      env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL },
    }
    writeRaw(JSON.stringify(original))

    const result = applyProxyBaseUrl(settingsPath, () => ({
      ok: false,
      error: "no API key configured",
    }))

    expect(result.wrote).toBe(false)
    expect(result.skippedReason).toBe("missing-api-key")
    expect(read()).toEqual(original)
  })

  it("does not overwrite a marked helper that was edited afterward", () => {
    apply()
    const edited = { ...read(), apiKeyHelper: "echo 'changed-by-user'" }
    writeRaw(JSON.stringify(edited))

    const result = apply()

    expect(result.wrote).toBe(false)
    expect(result.skippedReason).toBe("foreign-api-key-helper")
    expect(read()).toEqual(edited)
  })

  it("ownership guard: does NOT overwrite a foreign apiKeyHelper", () => {
    const original = { apiKeyHelper: "other-helper" }
    writeRaw(JSON.stringify(original))
    const result = apply()
    expect(result.wrote).toBe(false)
    expect(result.skippedReason).toBe("foreign-api-key-helper")
    expect(read()).toEqual(original)
  })
})

describe("applyProxyBaseUrl API-key provisioning", () => {
  it("provisions a Claude Code key when no usable key exists", () => {
    const result = applyProxyBaseUrl(settingsPath)

    expect(result.wrote).toBe(true)
    const entries = getConfig().auth?.apiKeyEntries ?? []
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      label: "claude-code",
      enabled: true,
    })
    expect(entries[0]?.key).toMatch(/^mxl_[\w-]+$/u)
    expect(read().apiKeyHelper).toBe(`echo '${entries[0]?.key}'`)
  })

  it("does not provision more than one key across repeated applies", () => {
    applyProxyBaseUrl(settingsPath)
    applyProxyBaseUrl(settingsPath)

    expect(getConfig().auth?.apiKeyEntries).toHaveLength(1)
  })

  it("does not provision a key when the base URL is foreign", () => {
    writeRaw(
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: "https://other.example" },
      }),
    )

    const result = applyProxyBaseUrl(settingsPath)

    expect(result.skippedReason).toBe("foreign-base-url")
    expect(getConfig().auth?.apiKeyEntries ?? []).toEqual([])
  })
})

describe("revertProxyBaseUrl", () => {
  it("removes only our key, preserves sibling env + other settings", () => {
    writeRaw(
      JSON.stringify({
        theme: "dark",
        apiKeyHelper: TEST_HELPER,
        _maximalHelper: TEST_MARKER,
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
        apiKeyHelper: TEST_HELPER,
        _maximalHelper: TEST_MARKER,
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
        apiKeyHelper: TEST_HELPER,
        _maximalHelper: TEST_MARKER,
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
    writeRaw(
      JSON.stringify({
        apiKeyHelper: TEST_HELPER,
        _maximalHelper: TEST_MARKER,
      }),
    )
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

  it("preserves a marked helper that was edited after apply", () => {
    apply()
    const edited = { ...read(), apiKeyHelper: "echo 'changed-by-user'" }
    writeRaw(JSON.stringify(edited))

    const result = revertProxyBaseUrl(settingsPath)

    expect(result.wrote).toBe(true)
    expect(read()).toEqual({ apiKeyHelper: "echo 'changed-by-user'" })
  })

  it("removes our classifier setting after both routing fields are edited", () => {
    apply()
    const edited = read()
    writeRaw(
      JSON.stringify({
        ...edited,
        apiKeyHelper: "other-helper",
        env: {
          ...envOf(edited),
          ANTHROPIC_BASE_URL: "https://other.example",
        },
      }),
    )

    const result = revertProxyBaseUrl(settingsPath)

    expect(result.wrote).toBe(true)
    expect(read()).toEqual({
      apiKeyHelper: "other-helper",
      env: { ANTHROPIC_BASE_URL: "https://other.example" },
    })
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
    apply()
    revertProxyBaseUrl(settingsPath)
    // Nothing was there before, so disable removes everything (file gone).
    expect(fs.existsSync(settingsPath)).toBe(false)
  })

  it("restores a user's OWN ANTHROPIC_BASE_URL that equals the proxy URL", () => {
    // The coincidence trap: the user had set the proxy URL themselves. Ownership
    // reads "ours", but a blind delete would drop THEIR value. The snapshot makes
    // disable restore it exactly.
    writeRaw(JSON.stringify({ env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL } }))
    apply()
    revertProxyBaseUrl(settingsPath)
    expect(read()).toEqual({ env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL } })
  })

  it("removes a migrated legacy helper when routing is disabled", () => {
    const legacyHelper = '"/old/maximal" --apiKeyHelper claude-code'
    writeRaw(JSON.stringify({ apiKeyHelper: legacyHelper }))

    apply()
    revertProxyBaseUrl(settingsPath)

    expect(fs.existsSync(settingsPath)).toBe(false)
  })

  it("preserves unrelated settings + sibling env across the round-trip", () => {
    const before = {
      theme: "dark",
      permissions: { allow: ["Bash"] },
      env: { FOO: "1", ANTHROPIC_API_KEY: "sk-secret" },
    }
    writeRaw(JSON.stringify(before))
    apply()
    revertProxyBaseUrl(settingsPath)
    expect(read()).toEqual(before)
  })

  it("re-apply (self-heal) does not poison the snapshot", () => {
    // The execPath self-heal re-runs applyProxyBaseUrl. It must NOT capture our
    // own values as the prior state, or disable would restore the proxy URL.
    apply()
    apply() // self-heal / re-apply
    revertProxyBaseUrl(settingsPath)
    expect(fs.existsSync(settingsPath)).toBe(false)
  })
})

describe("isProxyBaseUrlConfigured", () => {
  it("requires both the owned base URL and the owned helper", () => {
    expect(isProxyBaseUrlConfigured(settingsPath)).toBe(false)

    writeRaw(JSON.stringify({ env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL } }))
    expect(isProxyBaseUrlConfigured(settingsPath)).toBe(false)

    writeRaw(
      JSON.stringify({
        apiKeyHelper: TEST_HELPER,
        _maximalHelper: TEST_MARKER,
      }),
    )
    expect(isProxyBaseUrlConfigured(settingsPath)).toBe(false)

    writeRaw(
      JSON.stringify({
        apiKeyHelper: TEST_HELPER,
        _maximalHelper: TEST_MARKER,
        env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL },
      }),
    )
    expect(isProxyBaseUrlConfigured(settingsPath)).toBe(true)
  })
})
