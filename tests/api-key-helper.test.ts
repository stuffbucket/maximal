import { describe, expect, test } from "bun:test"

import type { ApiKeyEntry, AppConfig } from "~/lib/config"

import {
  apiKeyHelperCommand,
  resolveApiKey,
  runApiKeyHelper,
} from "~/lib/api-key-helper"

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

describe("apiKeyHelperCommand", () => {
  test("includes the trimmed label when one is given", () => {
    expect(apiKeyHelperCommand("claude-code")).toBe(
      "maximal --apiKeyHelper claude-code",
    )
    expect(apiKeyHelperCommand("  spaced  ")).toBe(
      "maximal --apiKeyHelper spaced",
    )
  })

  test("omits the label when absent or blank", () => {
    expect(apiKeyHelperCommand()).toBe("maximal --apiKeyHelper")
    expect(apiKeyHelperCommand("")).toBe("maximal --apiKeyHelper")
    expect(apiKeyHelperCommand("   ")).toBe("maximal --apiKeyHelper")
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

type ApiKeyHelperVerdict = ReturnType<typeof resolveApiKey>
