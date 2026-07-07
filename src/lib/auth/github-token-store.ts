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

import { PATHS } from "~/lib/platform/paths"

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

/**
 * Atomic JSON write: serialize to a sibling temp file, fsync-free rename over
 * the target. A torn write would otherwise lose every account in the registry
 * (it's one multi-key blob), so the rename — atomic on POSIX — is the
 * difference between "old contents intact" and "corrupt/empty file" on a crash
 * mid-write. Mode 0o600 on the temp file so the secret is never world-readable
 * even for the instant before the rename.
 */
async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  const json = `${JSON.stringify(value, null, 2)}\n`
  const tmp = `${filePath}.tmp.${process.pid}`
  // codeql[js/http-to-file-access] -- by design: persists the OAuth token we just received to a 0o600 file under ~/.local/share/copilot-api/. That is this function's job — same model as `gh auth login`. See ADR-0001.
  await fs.writeFile(tmp, json, { mode: 0o600 })
  await fs.rename(tmp, filePath)
}

export async function writeGitHubTokenRecord(
  filePath: string,
  record: GitHubTokenRecord,
): Promise<void> {
  await writeJsonAtomic(filePath, record)
}

// ---------------------------------------------------------------------------
// Multi-account registry (schema v2)
//
// The single-record file above stores at most one identity. The registry holds
// N accounts keyed by `login@host` with a pointer at the active one, so the UI
// can quick-switch between them (set active → reboot into that config). It is
// the source of truth; the legacy single-record file is kept only as a
// migration input + read-fallback (see readDefaultRecord). Writes are atomic.
// ---------------------------------------------------------------------------

export type AddedVia = "device-code" | "gh-cli" | "migration"

/** Last fatal rejection recorded for an account (Copilot 401/403). Retained
 *  on the record so the UI can explain WHY and logs have a durable trail. */
export interface AccountAuthError {
  status: number | null
  message: string
  at: string
}

/** One stored identity. `login@host` is the dedup key — re-adding the same
 *  identity replaces the token (latest wins) rather than duplicating. */
export interface AccountRecord {
  login: string
  host: string
  token: string
  tokenType: TokenType
  addedVia: AddedVia
  obtainedAt: string
  /**
   * Set when this account's credential was rejected by Copilot (401/403).
   * The record + token are RETAINED, never deleted — destroying a credential
   * on a transient upstream rejection was the bug that forced constant
   * re-auth. Cleared on the next successful mint. Optional for backward
   * compatibility: registries written before this field round-trip cleanly
   * (readRegistry passes `accounts` through verbatim).
   */
  needsReauth?: boolean
  /** The rejection that set `needsReauth`, for UI + logs. */
  lastError?: AccountAuthError | null
}

/** Stable identity key. Hosts are gh's host format (`github.com` / a GHES
 *  domain), so a maximal device-code account and the same gh-imported account
 *  collapse to one entry. */
export type AccountKey = string

export interface AccountRegistry {
  schemaVersion: 2
  activeKey: AccountKey | null
  accounts: Record<AccountKey, AccountRecord>
}

export function accountKey(login: string, host: string): AccountKey {
  return `${login}@${host}`
}

export function emptyRegistry(): AccountRegistry {
  return { schemaVersion: 2, activeKey: null, accounts: {} }
}

export function makeAccountRecord(opts: {
  login: string
  host: string
  token: string
  addedVia: AddedVia
}): AccountRecord {
  return {
    login: opts.login,
    host: opts.host,
    token: opts.token,
    tokenType: inferTokenType(opts.token),
    addedVia: opts.addedVia,
    obtainedAt: new Date().toISOString(),
  }
}

/** Insert/replace `rec` by its `login@host` key and make it the active account.
 *  Pure — returns a new registry; the caller persists it. */
export function addAndActivate(
  reg: AccountRegistry,
  rec: AccountRecord,
): AccountRegistry {
  const key = accountKey(rec.login, rec.host)
  return {
    schemaVersion: 2,
    activeKey: key,
    accounts: { ...reg.accounts, [key]: rec },
  }
}

/** Point `activeKey` at an existing account. No-op (returns input) if the key
 *  isn't present, so a stale switch can't create a dangling pointer. */
export function setActive(
  reg: AccountRegistry,
  key: AccountKey,
): AccountRegistry {
  if (!(key in reg.accounts)) return reg
  return { ...reg, activeKey: key }
}

/** Drop an account. If it was active, `activeKey` falls back to null (caller
 *  reboots into unauthenticated). */
export function removeAccount(
  reg: AccountRegistry,
  key: AccountKey,
): AccountRegistry {
  if (!(key in reg.accounts)) return reg
  const accounts = Object.fromEntries(
    Object.entries(reg.accounts).filter(([k]) => k !== key),
  )
  return {
    schemaVersion: 2,
    activeKey: reg.activeKey === key ? null : reg.activeKey,
    accounts,
  }
}

/** Deactivate the active account WITHOUT deleting it — drop the active
 *  pointer but keep every record (and its token). The signed-out / degraded
 *  state then still knows which account it was, so the UI can name it and
 *  offer one-click (or zero-click) reconnect. Pure. Contrast `removeAccount`,
 *  which forgets the credential entirely. */
export function deactivate(reg: AccountRegistry): AccountRegistry {
  if (!reg.activeKey) return reg
  return { ...reg, activeKey: null }
}

/** Flag an account as needing re-auth (its credential was rejected). Retains
 *  the record + token; records the rejection for the UI/logs. No-op if the
 *  key is absent. Pure. */
export function markNeedsReauth(
  reg: AccountRegistry,
  key: AccountKey,
  error: AccountAuthError,
): AccountRegistry {
  if (!(key in reg.accounts)) return reg
  const rec = reg.accounts[key]
  return {
    ...reg,
    accounts: {
      ...reg.accounts,
      [key]: { ...rec, needsReauth: true, lastError: error },
    },
  }
}

/** Clear an account's needs-reauth flag (its credential worked again). No-op
 *  if the key is absent or already clean. Pure. */
export function clearNeedsReauth(
  reg: AccountRegistry,
  key: AccountKey,
): AccountRegistry {
  if (!(key in reg.accounts)) return reg
  const rec = reg.accounts[key]
  if (!rec.needsReauth && !rec.lastError) return reg
  return {
    ...reg,
    accounts: {
      ...reg.accounts,
      [key]: { ...rec, needsReauth: false, lastError: null },
    },
  }
}

export function getActiveRecord(reg: AccountRegistry): AccountRecord | null {
  if (!reg.activeKey) return null
  return reg.accounts[reg.activeKey] ?? null
}

export function listAccounts(
  reg: AccountRegistry,
): Array<AccountRecord & { key: AccountKey; active: boolean }> {
  return Object.entries(reg.accounts).map(([key, rec]) => ({
    ...rec,
    key,
    active: key === reg.activeKey,
  }))
}

/** Read the registry, tolerating absence/corruption by returning empty. Never
 *  throws — a bad registry file degrades to "no accounts", same as the
 *  single-record reader. */
export async function readRegistry(filePath: string): Promise<AccountRegistry> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf8")
  } catch {
    return emptyRegistry()
  }
  const trimmed = raw.trim()
  if (!trimmed) return emptyRegistry()
  try {
    const parsed = JSON.parse(trimmed) as Partial<AccountRegistry>
    if (
      parsed.schemaVersion === 2
      && parsed.accounts
      && typeof parsed.accounts === "object"
    ) {
      return {
        schemaVersion: 2,
        activeKey: parsed.activeKey ?? null,
        accounts: parsed.accounts,
      }
    }
  } catch {
    /* fall through to empty */
  }
  return emptyRegistry()
}

export async function writeRegistry(
  filePath: string,
  reg: AccountRegistry,
): Promise<void> {
  await writeJsonAtomic(filePath, reg)
}

/**
 * One-time upgrade of a legacy single-record token file into the registry.
 * Gated: no-op (returns null) when the registry already holds accounts or no
 * legacy token exists. The legacy file has only a token — no login/host — so
 * the caller injects `resolveLogin` (a GitHub user lookup) and the `host` it
 * derives from config. When the lookup fails (offline), the account is still
 * migrated under `unknown@host` so the token isn't lost; a later sign-in keyed
 * with a real login supersedes it. The legacy file is left in place as a
 * rollback fallback — migration won't re-run because the registry is now
 * non-empty.
 */
export async function migrateLegacyRecord(opts: {
  legacyPath: string
  registryPath: string
  host: string
  resolveLogin: (token: string) => Promise<string | null>
}): Promise<AccountRegistry | null> {
  const existing = await readRegistry(opts.registryPath)
  if (Object.keys(existing.accounts).length > 0) return null

  const legacy = await readGitHubTokenRecord(opts.legacyPath)
  if (!legacy) return null

  const login = (await opts.resolveLogin(legacy.accessToken)) ?? "unknown"
  const rec = makeAccountRecord({
    login,
    host: opts.host,
    token: legacy.accessToken,
    addedVia: "migration",
  })
  // Preserve the legacy obtainedAt rather than stamping "now".
  rec.obtainedAt = legacy.obtainedAt
  const migrated = addAndActivate(emptyRegistry(), rec)
  await writeRegistry(opts.registryPath, migrated)
  return migrated
}

/** The registry file that sits beside a given legacy token file — same
 *  directory, same enterprise prefix (`github_token` → `accounts.json`,
 *  `ent_github_token` → `ent_accounts.json`). Lets a caller holding a token
 *  path (e.g. setup-status, parameterised for test isolation) find the
 *  matching registry without hard-coding `PATHS.ACCOUNTS_PATH`. */
export function registryPathFor(tokenPath: string): string {
  return tokenPath.replace(/github_token$/, "accounts.json")
}

/** Production shorthands using the default registry path from `PATHS`. */
export const readDefaultRegistry = (): Promise<AccountRegistry> =>
  readRegistry(PATHS.ACCOUNTS_PATH)

export const writeDefaultRegistry = (reg: AccountRegistry): Promise<void> =>
  writeRegistry(PATHS.ACCOUNTS_PATH, reg)

// Concurrency: these read-modify-write helpers take no lock. That's safe on a
// single sidecar — Bun's event loop serializes Hono handlers, so no two writes
// interleave (the `await`s yield, but the next handler doesn't start mid-write).
// The only race is the pathological case of running the `maximal auth` CLI (a
// separate process) WHILE the sidecar is live; a lost write there drops an
// account entry (not the GitHub credential — re-add via gh-reuse or re-auth),
// and the atomic temp+rename write rules out a corrupt/torn file regardless.
// Not a documented workflow; revisit with an OS file-lock if the CLI ever
// becomes a first-class concurrent auth path.

/** Read-modify-write: add (or replace by `login@host`) an account, make it the
 *  active one, persist. The shared path for every sign-in producer
 *  (device-code, CLI, gh-reuse). */
export async function addAccountToDefaultRegistry(
  rec: AccountRecord,
): Promise<void> {
  const reg = await readDefaultRegistry()
  await writeDefaultRegistry(addAndActivate(reg, rec))
}

/** Sign-out helper that RETAINS the account: drop the active pointer but keep
 *  every record. The signed-out UI can still name the last account and offer
 *  reconnect. No-op when nothing is active. */
export async function deactivateActiveInDefaultRegistry(): Promise<void> {
  const reg = await readDefaultRegistry()
  if (!reg.activeKey) return
  await writeDefaultRegistry(deactivate(reg))
}

/** Flag the active account as needing re-auth on disk (credential rejected),
 *  retaining its record + token. No-op when nothing is active. */
export async function markActiveNeedsReauthInDefaultRegistry(
  error: AccountAuthError,
): Promise<void> {
  const reg = await readDefaultRegistry()
  if (!reg.activeKey) return
  await writeDefaultRegistry(markNeedsReauth(reg, reg.activeKey, error))
}

/** Clear the active account's needs-reauth flag on disk after a successful
 *  mint/refresh (the credential works again). Write-if-changed: `clearNeedsReauth`
 *  returns the same registry when there's nothing flagged, so a healthy session
 *  doesn't rewrite the file on every refresh. No-op when nothing is active. */
export async function clearActiveNeedsReauthInDefaultRegistry(): Promise<void> {
  const reg = await readDefaultRegistry()
  if (!reg.activeKey) return
  const cleared = clearNeedsReauth(reg, reg.activeKey)
  if (cleared === reg) return
  await writeDefaultRegistry(cleared)
}

/** Flag a SPECIFIC account (by key) as needing re-auth on disk — for the
 *  auto-recovery sweep to mark a candidate that fails preflight or mint without
 *  it being the active account. No-op when the key is absent. */
export async function markNeedsReauthInDefaultRegistry(
  key: AccountKey,
  error: AccountAuthError,
): Promise<void> {
  const reg = await readDefaultRegistry()
  await writeDefaultRegistry(markNeedsReauth(reg, key, error))
}

/** Commit a recovered account as active on disk and clear its needs-reauth in
 *  one read-modify-write — for auto-recovery's live switch, AFTER the mint has
 *  succeeded. Keeps the registry read/write inside the store layer instead of
 *  the caller hand-composing the pure helpers. No-op on the active pointer when
 *  the key is absent (setActive guards it). */
export async function activateAndClearNeedsReauthInDefaultRegistry(
  key: AccountKey,
): Promise<void> {
  const reg = await readDefaultRegistry()
  await writeDefaultRegistry(clearNeedsReauth(setActive(reg, key), key))
}

/**
 * Back-compat read: "the active account's token", in the legacy record shape.
 * Boot, the CLI auth reuse-check, setup-status, and debug all just want the
 * active token, so they keep calling this unchanged. Falls back to the legacy
 * single-record file when the registry is still empty (the pre-migration
 * window, or a non-boot caller that hasn't migrated) so the token is never
 * invisible. Read-only — does not migrate.
 */
export const readDefaultRecord =
  async (): Promise<GitHubTokenRecord | null> => {
    const active = getActiveRecord(await readDefaultRegistry())
    if (active) {
      return {
        schemaVersion: 1,
        tokenType: active.tokenType,
        accessToken: active.token,
        refreshToken: null,
        obtainedAt: active.obtainedAt,
      }
    }
    return readGitHubTokenRecord(PATHS.GITHUB_TOKEN_PATH)
  }
