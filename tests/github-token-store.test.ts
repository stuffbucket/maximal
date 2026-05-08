/**
 * Coverage for the GitHub token storage shape — both the v1 JSON path and
 * the legacy bare-string auto-upgrade. Uses explicit file paths so the
 * test doesn't depend on `paths.ts`'s import-time env capture.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  inferTokenType,
  makeRecord,
  readGitHubTokenRecord,
  writeGitHubTokenRecord,
} from "~/lib/github-token-store"

const TMP_ROOT = path.join(os.tmpdir(), `gh-token-store-${Date.now()}`)
let tokenPath: string

beforeEach(async () => {
  const dir = path.join(TMP_ROOT, `case-${crypto.randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  tokenPath = path.join(dir, "github_token")
})

afterEach(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {})
})

describe("inferTokenType", () => {
  it("detects ghu_, gho_, and unknown prefixes", () => {
    expect(inferTokenType("ghu_abc123")).toBe("ghu_")
    expect(inferTokenType("gho_abc123")).toBe("gho_")
    expect(inferTokenType("ghs_abc123")).toBe("unknown")
    expect(inferTokenType("")).toBe("unknown")
  })
})

describe("readGitHubTokenRecord — v1 JSON", () => {
  it("returns null when the file is absent", async () => {
    expect(await readGitHubTokenRecord(tokenPath)).toBeNull()
  })

  it("parses a v1 JSON record", async () => {
    await writeGitHubTokenRecord(tokenPath, {
      schemaVersion: 1,
      tokenType: "ghu_",
      accessToken: "ghu_test_token",
      refreshToken: null,
      obtainedAt: "2026-05-08T00:00:00Z",
    })
    const r = await readGitHubTokenRecord(tokenPath)
    expect(r?.accessToken).toBe("ghu_test_token")
    expect(r?.tokenType).toBe("ghu_")
    expect(r?.obtainedAt).toBe("2026-05-08T00:00:00Z")
  })

  it("falls back to bare-string treatment when JSON is malformed", async () => {
    await fs.writeFile(tokenPath, "{ not valid json", "utf8")
    const r = await readGitHubTokenRecord(tokenPath)
    expect(r?.accessToken).toBe("{ not valid json")
    expect(r?.tokenType).toBe("unknown")
  })
})

describe("readGitHubTokenRecord — legacy bare-string", () => {
  it("auto-upgrades a bare ghu_ token to v1 JSON on read", async () => {
    await fs.writeFile(tokenPath, "ghu_legacy_token", "utf8")
    const r = await readGitHubTokenRecord(tokenPath)
    expect(r?.accessToken).toBe("ghu_legacy_token")
    expect(r?.tokenType).toBe("ghu_")
    const after = await fs.readFile(tokenPath, "utf8")
    expect(after.trim().startsWith("{")).toBe(true)
    const parsed = JSON.parse(after) as {
      schemaVersion: number
      accessToken: string
    }
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.accessToken).toBe("ghu_legacy_token")
  })

  it("auto-detects gho_ prefix on bare upgrade", async () => {
    await fs.writeFile(tokenPath, "gho_opencode_style", "utf8")
    const r = await readGitHubTokenRecord(tokenPath)
    expect(r?.tokenType).toBe("gho_")
  })

  it("returns null for empty file", async () => {
    await fs.writeFile(tokenPath, "", "utf8")
    expect(await readGitHubTokenRecord(tokenPath)).toBeNull()
  })
})

describe("writeGitHubTokenRecord", () => {
  it("writes mode 0o600 on POSIX", async () => {
    await writeGitHubTokenRecord(tokenPath, makeRecord("ghu_test"))
    if (process.platform !== "win32") {
      const stat = await fs.stat(tokenPath)
      expect(stat.mode & 0o777).toBe(0o600)
    }
  })

  it("makeRecord populates obtainedAt with a fresh timestamp", () => {
    const before = Date.now()
    const r = makeRecord("ghu_x")
    const ts = new Date(r.obtainedAt).getTime()
    expect(ts).toBeGreaterThanOrEqual(before - 1000)
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000)
  })
})
