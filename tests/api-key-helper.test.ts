import { describe, expect, test } from "bun:test"

import type { ApiKeyEntry, AppConfig } from "~/lib/config/config"

import {
  apiKeyHelperCommand,
  ensureDefaultEndpointKey,
  generateApiKeyValue,
  isOwnedApiKeyHelper,
  resolveApiKey,
  runApiKeyHelper,
} from "~/lib/auth/api-key-helper"
import { API_KEY_VALUE_PATTERN } from "~/lib/config/config-schema"

/**
 * Unit coverage for the generic apiKeyHelper resolver.
 *
 * `resolveApiKey` takes an injectable `config` param, so every case here
 * passes an explicit AppConfig — no reliance on real on-disk config, FS, or
 * network, and no cross-file ordering hazards. `runApiKeyHelper` has no config
 * param (it reads ambient config), so it's exercised only for return-code +
 * output-format wiring against whatever the ambient config yields (see below).
 */

function entry(overrides: Partial<ApiKeyEntry> = {}): ApiKeyEntry {
  return {
    id: "id-default",
    label: "Default",
    key: "k-default",
    enabled: true,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function config(auth: AppConfig["auth"]): AppConfig {
  return { auth }
}

/** Injected seams keep {@link ensureDefaultEndpointKey} off the real FS/config
 *  entirely: an in-memory config with deterministic mint/id/now. */
function ensureKeyHarness(initial: AppConfig) {
  let current = initial
  const writes: Array<AppConfig> = []
  const deps = {
    read: () => current,
    write: (c: AppConfig) => {
      current = c
      writes.push(c)
    },
    mintKey: () => "mxl_minted",
    newId: () => "id-minted",
    now: () => "2026-07-20T00:00:00.000Z",
  }
  return { deps, writes, get: () => current }
}

describe("apiKeyHelperCommand", () => {
  // An explicit execPath keeps these deterministic (the default is the test
  // runner's binary). The command embeds the ABSOLUTE path, double-quoted, so a
  // GUI-launched client with a minimal PATH can still find maximal.
  const BIN = "/Applications/Maximal.app/Contents/MacOS/maximal"

  test("includes the trimmed label when one is given", () => {
    expect(apiKeyHelperCommand("claude-code", BIN)).toBe(
      `"${BIN}" api claude-code`,
    )
    expect(apiKeyHelperCommand("  spaced  ", BIN)).toBe(`"${BIN}" api spaced`)
  })

  test("omits the label when absent or blank", () => {
    expect(apiKeyHelperCommand(undefined, BIN)).toBe(`"${BIN}" api`)
    expect(apiKeyHelperCommand("", BIN)).toBe(`"${BIN}" api`)
    expect(apiKeyHelperCommand("   ", BIN)).toBe(`"${BIN}" api`)
  })

  test("quotes a path containing spaces so sh/cmd treat it as one token", () => {
    const spaced = "/Users/x/My Apps/Maximal.app/Contents/MacOS/maximal"
    expect(apiKeyHelperCommand("claude-code", spaced)).toBe(
      `"${spaced}" api claude-code`,
    )
  })

  // When maximal runs under a RUNTIME (bun/node) rather than the compiled
  // binary, process.execPath is the runtime — a bare `"…/bun" api claude-code`
  // would make the client exec a script named `api`. So we emit the two-token
  // `"<runtime>" "<entry-script>"` form, which actually invokes maximal's CLI.
  const BUN = "/opt/homebrew/Cellar/bun/1.3.10/bin/bun"
  const ENTRY = "/Users/x/maximal/src/main.ts"

  test("runtime execPath (bun) → two-token form with the entry script", () => {
    expect(apiKeyHelperCommand("claude-code", BUN, ENTRY)).toBe(
      `"${BUN}" "${ENTRY}" api claude-code`,
    )
  })

  test("runtime execPath (node) → two-token form", () => {
    const node = "/usr/local/bin/node"
    expect(apiKeyHelperCommand("claude-code", node, ENTRY)).toBe(
      `"${node}" "${ENTRY}" api claude-code`,
    )
  })

  test("a Windows runtime basename (bun.exe) is still detected", () => {
    const bunExe = String.raw`C:\Users\x\bun.exe`
    expect(apiKeyHelperCommand(undefined, bunExe, ENTRY)).toBe(
      `"${bunExe}" "${ENTRY}" api`,
    )
  })

  test("compiled maximal binary ignores mainScript (single-token form)", () => {
    // basename `maximal` (or `maximal-<triple>`) is NOT a runtime → the entry
    // script is irrelevant; the compiled path invokes itself directly.
    expect(apiKeyHelperCommand("claude-code", BIN, ENTRY)).toBe(
      `"${BIN}" api claude-code`,
    )
    const triple =
      "/Applications/Maximal.app/Contents/MacOS/maximal-aarch64-apple-darwin"
    expect(apiKeyHelperCommand("claude-code", triple, ENTRY)).toBe(
      `"${triple}" api claude-code`,
    )
  })
})

describe("isOwnedApiKeyHelper", () => {
  test("recognizes the current `api <label>` form regardless of binary path", () => {
    expect(
      isOwnedApiKeyHelper(
        '"/Applications/Maximal.app/Contents/MacOS/maximal" api claude-code',
        "claude-code",
      ),
    ).toBe(true)
    expect(
      isOwnedApiKeyHelper(
        '"/opt/homebrew/bin/maximal" api claude-code',
        "claude-code",
      ),
    ).toBe(true)
  })

  test("still recognizes the legacy `--apiKeyHelper <label>` form (heal-forward path)", () => {
    // A config written by an older maximal must be classified ours so apply/boot
    // rewrites it to the current `api <label>` form rather than orphaning it.
    expect(
      isOwnedApiKeyHelper(
        '"/Applications/Maximal.app/Contents/MacOS/maximal" --apiKeyHelper claude-code',
        "claude-code",
      ),
    ).toBe(true)
    expect(
      isOwnedApiKeyHelper(
        '"/opt/homebrew/bin/maximal" --apiKeyHelper claude-code',
        "claude-code",
      ),
    ).toBe(true)
    // The old bare-string legacy form is still recognized (pre-quoting upgrade).
    expect(
      isOwnedApiKeyHelper("maximal --apiKeyHelper claude-code", "claude-code"),
    ).toBe(true)
  })

  test('recognizes the runtime two-token form `"<runtime>" "<entry>" api <label>`', () => {
    // A dev/bun invocation writes execPath + entry-script. It must be classed
    // ours so the packaged app heals it forward to the single-token compiled
    // path on next boot.
    expect(
      isOwnedApiKeyHelper(
        '"/opt/homebrew/bin/bun" "/Users/x/maximal/src/main.ts" api claude-code',
        "claude-code",
      ),
    ).toBe(true)
  })

  test("two-token form with the wrong label is NOT ours", () => {
    expect(
      isOwnedApiKeyHelper(
        '"/opt/homebrew/bin/bun" "/Users/x/maximal/src/main.ts" api other',
        "claude-code",
      ),
    ).toBe(false)
  })

  test("rejects a genuinely foreign helper — including a foreign bare `api` invocation", () => {
    expect(isOwnedApiKeyHelper("/usr/bin/my-secret-tool", "claude-code")).toBe(
      false,
    )
    expect(isOwnedApiKeyHelper("echo hunter2", "claude-code")).toBe(false)
    // Right subcommand, wrong label → not ours for this client.
    expect(isOwnedApiKeyHelper('"/x/maximal" api other', "claude-code")).toBe(
      false,
    )
    // Bare-word `api` is common; a foreign tool using it must NOT match — the
    // current form is anchored on a leading quoted path.
    expect(
      isOwnedApiKeyHelper("some-tool api claude-code", "claude-code"),
    ).toBe(false)
    expect(isOwnedApiKeyHelper("api claude-code", "claude-code")).toBe(false)
  })

  test("rejects non-string input", () => {
    expect(isOwnedApiKeyHelper(undefined, "claude-code")).toBe(false)
    expect(isOwnedApiKeyHelper(42, "claude-code")).toBe(false)
  })
})

describe("resolveApiKey — label match", () => {
  test("exact label match resolves to that entry, source app", () => {
    const cfg = config({
      apiKeyEntries: [
        entry({ id: "claude-code", label: "Claude Code", key: "k-cc" }),
        entry({ id: "other", label: "Other", key: "k-other" }),
      ],
    })
    const result = resolveApiKey("Claude Code", cfg)
    expect(result).toEqual({ ok: true, key: "k-cc", source: "app" })
  })

  test("match is case- and separator-insensitive (normalizeLabel)", () => {
    const cfg = config({
      apiKeyEntries: [
        entry({ id: "claude-code", label: "Claude Code", key: "k-cc" }),
      ],
    })
    // "claude-code" / "CLAUDE_CODE" / "  Claude   Code " all normalize equal.
    expect(resolveApiKey("claude-code", cfg)).toEqual({
      ok: true,
      key: "k-cc",
      source: "app",
    })
    expect(resolveApiKey("CLAUDE_CODE", cfg)).toEqual({
      ok: true,
      key: "k-cc",
      source: "app",
    })
    expect(resolveApiKey("  Claude   Code ", cfg)).toEqual({
      ok: true,
      key: "k-cc",
      source: "app",
    })
  })

  test("returns the trimmed key from a matched entry", () => {
    const cfg = config({
      apiKeyEntries: [entry({ id: "cc", label: "CC", key: "  padded-key  " })],
    })
    expect(resolveApiKey("cc", cfg)).toEqual({
      ok: true,
      key: "padded-key",
      source: "app",
    })
  })

  test("disabled matching entry is skipped → falls through to default", () => {
    const cfg = config({
      apiKeys: ["legacy-default"],
      apiKeyEntries: [
        entry({
          id: "claude-code",
          label: "Claude Code",
          key: "k-cc",
          enabled: false,
        }),
      ],
    })
    expect(resolveApiKey("claude-code", cfg)).toEqual({
      ok: true,
      key: "legacy-default",
      source: "default",
    })
  })

  test("an enabled but empty-key entry does not match", () => {
    const cfg = config({
      apiKeys: ["legacy-default"],
      apiKeyEntries: [
        entry({ id: "claude-code", label: "Claude Code", key: "   " }),
      ],
    })
    expect(resolveApiKey("claude-code", cfg)).toEqual({
      ok: true,
      key: "legacy-default",
      source: "default",
    })
  })
})

describe("resolveApiKey — default fallback", () => {
  test("no label → legacy apiKeys[0], source default", () => {
    const cfg = config({
      apiKeys: ["legacy-default"],
      apiKeyEntries: [entry({ id: "cc", label: "CC", key: "k-cc" })],
    })
    expect(resolveApiKey(undefined, cfg)).toEqual({
      ok: true,
      key: "legacy-default",
      source: "default",
    })
  })

  test("label matching nothing → default key, source default", () => {
    const cfg = config({
      apiKeys: ["legacy-default"],
      apiKeyEntries: [entry({ id: "cc", label: "CC", key: "k-cc" })],
    })
    expect(resolveApiKey("nonexistent", cfg)).toEqual({
      ok: true,
      key: "legacy-default",
      source: "default",
    })
  })

  test("no legacy apiKeys → first enabled apiKeyEntries is the default", () => {
    const cfg = config({
      apiKeyEntries: [
        entry({
          id: "disabled",
          label: "Disabled",
          key: "k-x",
          enabled: false,
        }),
        entry({ id: "first-enabled", label: "First", key: "  k-first  " }),
        entry({ id: "second", label: "Second", key: "k-second" }),
      ],
    })
    expect(resolveApiKey(undefined, cfg)).toEqual({
      ok: true,
      key: "k-first",
      source: "default",
    })
  })

  test("legacy apiKeys win over apiKeyEntries for the default", () => {
    const cfg = config({
      apiKeys: ["legacy-default"],
      apiKeyEntries: [entry({ id: "e", label: "E", key: "k-entry" })],
    })
    expect(resolveApiKey(undefined, cfg)).toEqual({
      ok: true,
      key: "legacy-default",
      source: "default",
    })
  })
})

describe("resolveApiKey — failure modes", () => {
  test("nothing configured at all → ok:false with an error string", () => {
    const result = resolveApiKey(undefined, config({}))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(typeof result.error).toBe("string")
      expect(result.error.length).toBeGreaterThan(0)
    }
  })

  test("empty config object (no auth) → ok:false", () => {
    const result = resolveApiKey(undefined, {})
    expect(result.ok).toBe(false)
  })

  test("unmatched label with no default → error mentions the label", () => {
    const cfg = config({ apiKeyEntries: [] })
    const result = resolveApiKey("my-client", cfg)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("my-client")
    }
  })

  test("default-only failure error does NOT invent a label", () => {
    const result = resolveApiKey(undefined, config({}))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).not.toContain('"')
    }
  })
})

describe("resolveApiKey — normalization (spec 1)", () => {
  // A single stored entry labeled "Claude Code"; every separator/casing
  // variant of the search term must resolve to it (source "app").
  const cfg = config({
    apiKeyEntries: [entry({ id: "x", label: "Claude Code", key: "k-cc" })],
  })
  const matched = { ok: true, key: "k-cc", source: "app" } as const

  test("dash, underscore, and space separators are equivalent", () => {
    expect(resolveApiKey("claude-code", cfg)).toEqual(matched)
    expect(resolveApiKey("claude_code", cfg)).toEqual(matched)
    expect(resolveApiKey("claude code", cfg)).toEqual(matched)
  })

  test("casing and repeated interior whitespace collapse", () => {
    expect(resolveApiKey("Claude   Code", cfg)).toEqual(matched)
  })

  test("leading/trailing separators are stripped", () => {
    expect(resolveApiKey("-claude-code-", cfg)).toEqual(matched)
  })
})

describe("resolveApiKey — word-boundary prefix, both directions (spec 2)", () => {
  test("search is a prefix of the stored name (search 'claude' → 'Claude Code')", () => {
    const cfg = config({
      apiKeyEntries: [entry({ id: "x", label: "Claude Code", key: "k-cc" })],
    })
    expect(resolveApiKey("claude", cfg)).toEqual({
      ok: true,
      key: "k-cc",
      source: "app",
    })
  })

  test("stored name is a prefix of the search (search 'claude code' → 'Claude')", () => {
    const cfg = config({
      apiKeyEntries: [entry({ id: "x", label: "Claude", key: "k-c" })],
    })
    expect(resolveApiKey("claude code", cfg)).toEqual({
      ok: true,
      key: "k-c",
      source: "app",
    })
  })
})

describe("resolveApiKey — non-matches (spec 3)", () => {
  test("divergent second word does NOT match ('claude desktop' vs 'claude code')", () => {
    const cfg = config({
      apiKeys: ["legacy-default"],
      apiKeyEntries: [entry({ id: "x", label: "Claude Desktop", key: "k-cd" })],
    })
    expect(resolveApiKey("claude code", cfg)).toEqual({
      ok: true,
      key: "legacy-default",
      source: "default",
    })
  })

  test("missing separator does NOT match ('claudecode' vs 'claude-code')", () => {
    // A separator normalizes to a SPACE, not nothing — so "claudecode"
    // (one token) cannot match the two-token "claude code".
    const cfg = config({
      apiKeys: ["legacy-default"],
      apiKeyEntries: [
        entry({ id: "claude-code", label: "Claude Code", key: "k-cc" }),
      ],
    })
    expect(resolveApiKey("claudecode", cfg)).toEqual({
      ok: true,
      key: "legacy-default",
      source: "default",
    })
  })

  test("partial word does NOT match across a boundary ('claude co' vs 'claude code')", () => {
    const cfg = config({
      apiKeys: ["legacy-default"],
      apiKeyEntries: [entry({ id: "x", label: "Claude Code", key: "k-cc" })],
    })
    expect(resolveApiKey("claude co", cfg)).toEqual({
      ok: true,
      key: "legacy-default",
      source: "default",
    })
  })
})

describe("resolveApiKey — exact beats prefix (spec 4)", () => {
  const exact = entry({ id: "a", label: "Claude Code", key: "k-exact" })
  const prefix = entry({
    id: "b",
    label: "Claude Code Desktop",
    key: "k-prefix",
  })
  const matchedExact = { ok: true, key: "k-exact", source: "app" } as const

  test("exact (100) wins over prefix (90) — exact listed first", () => {
    const cfg = config({ apiKeyEntries: [exact, prefix] })
    expect(resolveApiKey("claude code", cfg)).toEqual(matchedExact)
  })

  test("exact (100) wins over prefix (90) — exact listed last", () => {
    const cfg = config({ apiKeyEntries: [prefix, exact] })
    expect(resolveApiKey("claude code", cfg)).toEqual(matchedExact)
  })
})

describe("resolveApiKey — best-pick and tie-break (spec 5)", () => {
  test("higher score wins when the stronger match comes later", () => {
    const cfg = config({
      apiKeyEntries: [
        entry({ id: "a", label: "Claude Code Desktop", key: "k-weak" }),
        entry({ id: "b", label: "Claude Code", key: "k-strong" }),
      ],
    })
    expect(resolveApiKey("claude code", cfg)).toEqual({
      ok: true,
      key: "k-strong",
      source: "app",
    })
  })

  test("an earlier stronger match is NOT overwritten by a later weaker one", () => {
    const cfg = config({
      apiKeyEntries: [
        entry({ id: "a", label: "Claude Code", key: "k-strong" }),
        entry({ id: "b", label: "Claude Code Desktop", key: "k-weak" }),
      ],
    })
    expect(resolveApiKey("claude code", cfg)).toEqual({
      ok: true,
      key: "k-strong",
      source: "app",
    })
  })

  test("tie → first entry in the array wins (both score 90)", () => {
    const cfg = config({
      apiKeyEntries: [
        entry({ id: "a", label: "Claude Code", key: "k-first" }),
        entry({ id: "b", label: "Claude Desktop", key: "k-second" }),
      ],
    })
    expect(resolveApiKey("claude", cfg)).toEqual({
      ok: true,
      key: "k-first",
      source: "app",
    })
  })

  test("per-entry score is max(id, label): id matches while label scores 0", () => {
    const cfg = config({
      apiKeyEntries: [
        entry({ id: "claude-code", label: "Totally Unrelated", key: "k-id" }),
      ],
    })
    expect(resolveApiKey("claude code", cfg)).toEqual({
      ok: true,
      key: "k-id",
      source: "app",
    })
  })

  test("per-entry score is max(id, label): label matches while id scores 0", () => {
    const cfg = config({
      apiKeyEntries: [
        entry({ id: "zzz-unrelated", label: "Claude Code", key: "k-label" }),
      ],
    })
    expect(resolveApiKey("claude code", cfg)).toEqual({
      ok: true,
      key: "k-label",
      source: "app",
    })
  })
})

describe("resolveApiKey — disabled entries are skipped (spec 6)", () => {
  test("a disabled matching entry falls through to the next matching entry", () => {
    const cfg = config({
      apiKeyEntries: [
        entry({
          id: "a",
          label: "Claude Code",
          key: "k-disabled",
          enabled: false,
        }),
        entry({ id: "b", label: "Claude Code", key: "k-enabled" }),
      ],
    })
    expect(resolveApiKey("claude code", cfg)).toEqual({
      ok: true,
      key: "k-enabled",
      source: "app",
    })
  })
})

describe("resolveApiKey — label trimming (spec 8)", () => {
  test("leading/trailing whitespace on the search is trimmed before matching", () => {
    const cfg = config({
      apiKeyEntries: [entry({ id: "x", label: "Claude Code", key: "k-cc" })],
    })
    expect(resolveApiKey("  claude code  ", cfg)).toEqual({
      ok: true,
      key: "k-cc",
      source: "app",
    })
  })
})

describe("runApiKeyHelper", () => {
  /**
   * runApiKeyHelper reads ambient config (no DI). To stay deterministic and
   * order-independent we don't assert a fixed return code; instead we assert
   * its wiring: the return code and the stream it writes to are consistent with
   * resolveApiKey()'s own verdict on the same ambient config, and the output is
   * shaped correctly (bare key + newline on success, "ERROR: " on failure).
   */
  test("return code and output match resolveApiKey on ambient config", () => {
    const stdout: Array<string> = []
    const stderr: Array<string> = []
    const realOut = process.stdout.write.bind(process.stdout)
    const realErr = process.stderr.write.bind(process.stderr)
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      stdout.push(String(chunk))
      return true
    }
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderr.push(String(chunk))
      return true
    }

    let code: number
    let expected: ApiKeyHelperVerdict
    try {
      expected = resolveApiKey()
      code = runApiKeyHelper()
    } finally {
      process.stdout.write = realOut
      process.stderr.write = realErr
    }

    if (expected.ok) {
      expect(code).toBe(0)
      expect(stdout.join("")).toBe(`${expected.key}\n`)
      expect(stderr.join("")).toBe("")
    } else {
      expect(code).toBe(1)
      expect(stderr.join("")).toBe(`ERROR: ${expected.error}\n`)
      expect(stdout.join("")).toBe("")
    }
  })
})

describe("generateApiKeyValue", () => {
  test("is prefixed `mxl_` and matches the accepted key charset", () => {
    const key = generateApiKeyValue()
    expect(key.startsWith("mxl_")).toBe(true)
    expect(API_KEY_VALUE_PATTERN.test(key)).toBe(true)
  })

  test("is unique across calls", () => {
    expect(generateApiKeyValue()).not.toBe(generateApiKeyValue())
  })
})

describe("ensureDefaultEndpointKey", () => {
  const harness = ensureKeyHarness

  test("mints a `Default` entry when nothing is configured", () => {
    const h = harness({})
    ensureDefaultEndpointKey(h.deps)
    expect(h.writes).toHaveLength(1)
    expect(h.get().auth?.apiKeyEntries).toEqual([
      {
        id: "id-minted",
        label: "Default",
        key: "mxl_minted",
        enabled: true,
        created_at: "2026-07-20T00:00:00.000Z",
      },
    ])
    // The freshly-minted key is now resolvable as the default endpoint key.
    expect(resolveApiKey(undefined, h.get())).toEqual({
      ok: true,
      key: "mxl_minted",
      source: "default",
    })
  })

  test("no-op when a legacy apiKeys default already exists", () => {
    const h = harness(config({ apiKeys: ["legacy-default"] }))
    ensureDefaultEndpointKey(h.deps)
    expect(h.writes).toHaveLength(0)
  })

  test("no-op when an enabled apiKeyEntries default already exists", () => {
    const h = harness(
      config({ apiKeyEntries: [entry({ id: "e", key: "k-existing" })] }),
    )
    ensureDefaultEndpointKey(h.deps)
    expect(h.writes).toHaveLength(0)
  })

  test("mints when the only entry is disabled (no resolvable default)", () => {
    const h = harness(
      config({
        apiKeyEntries: [entry({ id: "d", key: "k-x", enabled: false })],
      }),
    )
    ensureDefaultEndpointKey(h.deps)
    expect(h.writes).toHaveLength(1)
    // Appends alongside the existing disabled entry rather than replacing it.
    expect(h.get().auth?.apiKeyEntries?.map((e) => e.id)).toEqual([
      "d",
      "id-minted",
    ])
  })

  test("is idempotent across repeated calls", () => {
    const h = harness({})
    ensureDefaultEndpointKey(h.deps)
    ensureDefaultEndpointKey(h.deps)
    ensureDefaultEndpointKey(h.deps)
    expect(h.writes).toHaveLength(1)
  })
})

type ApiKeyHelperVerdict = ReturnType<typeof resolveApiKey>
