/**
 * On-disk shape for the GitHub user token.
 *
 * Historically the file at `${COPILOT_API_HOME}/<oauth-app>/github_token`
 * contained a bare token string. v1 promotes it to JSON so future fields
 * (refresh tokens, expiry caching, multi-account) don't need a parse-rewrite
 * migration. Reads tolerate both shapes; writes are always v1 JSON.
 *
 * The token *prefix* tells us which Copilot exchange path applies:
 *   - `ghu_…` — GitHub-App user-to-server token (default; from
 *     `Iv1.b507a08c87ecfe98`). Exchange via `/copilot_internal/v2/token`,
 *     refresh on cadence.
 *   - `gho_…` — OAuth-App user token (e.g. opencode-style, or any
 *     `Ov23li…`-prefixed App). Used directly as a Copilot bearer; no
 *     refresh needed (these don't expire by default).
 *
 * Functions are path-parameterised for tests; production callers should
 * pass `PATHS.GITHUB_TOKEN_PATH` (see `readDefaultRecord` /
 * `writeDefaultRecord` shorthands below).
 */

import fs from "node:fs/promises"

import { PATHS } from "./paths"

export type TokenType = "ghu_" | "gho_" | "unknown"

export interface GitHubTokenRecord {
  schemaVersion: 1
  tokenType: TokenType
  accessToken: string
  /** Reserved for future GitHub-App refresh tokens; null today. */
  refreshToken: string | null
  /** ISO8601 timestamp; informational, not enforced. */
  obtainedAt: string
}

export function inferTokenType(token: string): TokenType {
  if (token.startsWith("ghu_")) return "ghu_"
  if (token.startsWith("gho_")) return "gho_"
  return "unknown"
}

export async function readGitHubTokenRecord(
  filePath: string,
): Promise<GitHubTokenRecord | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf8")
  } catch {
    return null
  }
  const trimmed = raw.trim()
  if (!trimmed) return null

  // v1 JSON path.
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<GitHubTokenRecord>
      if (
        parsed.schemaVersion === 1
        && typeof parsed.accessToken === "string"
        && parsed.accessToken
      ) {
        return {
          schemaVersion: 1,
          tokenType: parsed.tokenType ?? inferTokenType(parsed.accessToken),
          accessToken: parsed.accessToken,
          refreshToken: parsed.refreshToken ?? null,
          obtainedAt: parsed.obtainedAt ?? new Date(0).toISOString(),
        }
      }
    } catch {
      // fall through to "treat as bare token"
    }
  }

  // Bare-string path (legacy). Wrap into v1 and rewrite atomically so the
  // next read is fast.
  const record: GitHubTokenRecord = {
    schemaVersion: 1,
    tokenType: inferTokenType(trimmed),
    accessToken: trimmed,
    refreshToken: null,
    obtainedAt: new Date().toISOString(),
  }
  // Best-effort upgrade — don't block auth if disk is RO.
  try {
    await writeGitHubTokenRecord(filePath, record)
  } catch {
    /* ignore */
  }
  return record
}

export async function writeGitHubTokenRecord(
  filePath: string,
  record: GitHubTokenRecord,
): Promise<void> {
  const json = `${JSON.stringify(record, null, 2)}\n`
  await fs.writeFile(filePath, json, { mode: 0o600 })
}

export function makeRecord(
  accessToken: string,
  refreshToken: string | null = null,
): GitHubTokenRecord {
  return {
    schemaVersion: 1,
    tokenType: inferTokenType(accessToken),
    accessToken,
    refreshToken,
    obtainedAt: new Date().toISOString(),
  }
}

/** Production shorthands using the default path from `PATHS`. */
export const readDefaultRecord = (): Promise<GitHubTokenRecord | null> =>
  readGitHubTokenRecord(PATHS.GITHUB_TOKEN_PATH)

export const writeDefaultRecord = (record: GitHubTokenRecord): Promise<void> =>
  writeGitHubTokenRecord(PATHS.GITHUB_TOKEN_PATH, record)
