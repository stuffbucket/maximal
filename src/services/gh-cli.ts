/**
 * Local GitHub CLI (`gh`) detection — read-only hinting for the auth UI.
 *
 * Surfaces whether `gh` is installed and which accounts it's already signed
 * in to, so the Settings "Sign in" screen can offer "reuse a GitHub CLI
 * account" instead of forcing the device-code dance. This module ONLY reads
 * status: it shells out to `gh --version` and `gh auth status --json hosts`,
 * neither of which prints a token (the JSON carries login/host/active/scopes,
 * not the credential). Actually importing a `gh` token is a separate,
 * explicit step layered on top of this.
 *
 * The runner is injectable so tests exercise the parser without a real `gh`.
 */
import { type ExecFileException, execFile } from "node:child_process"

export interface GhAccount {
  login: string
  host: string
  /** Whether this is gh's currently-active account for the host. */
  active: boolean
  scopes: Array<string>
}

export interface GhCliStatus {
  installed: boolean
  /** e.g. "2.92.0"; null when not installed or unparseable. */
  version: string | null
  /** Signed-in accounts gh knows about. Empty when not installed, not
   *  signed in, or gh is too old to enumerate them (no `--json`). */
  accounts: Array<GhAccount>
}

interface GhRunResult {
  stdout: string
  stderr: string
  code: number
  /** True when the `gh` binary isn't on PATH (ENOENT). */
  notFound: boolean
}

/** Runs a `gh` subcommand. Injectable for tests. */
export type GhRunner = (args: Array<string>) => Promise<GhRunResult>

// gh status calls touch the OS keyring; cap them so a wedged keyring prompt
// can't hang the settings request.
const GH_TIMEOUT_MS = 5000

const defaultRunner: GhRunner = (args) =>
  new Promise((resolve) => {
    execFile(
      "gh",
      args,
      { encoding: "utf8", timeout: GH_TIMEOUT_MS, maxBuffer: 1_000_000 },
      (error: ExecFileException | null, stdout, stderr) => {
        if (error?.code === "ENOENT") {
          resolve({ stdout: "", stderr: "", code: 127, notFound: true })
          return
        }
        let code = 0
        if (error) {
          code = typeof error.code === "number" ? error.code : 1
        }
        resolve({ stdout, stderr, code, notFound: false })
      },
    )
  })

// "gh version 2.92.0 (2026-04-28)\n..." -> "2.92.0"
function parseVersion(stdout: string): string | null {
  return /gh version (\S+)/.exec(stdout)?.[1] ?? null
}

// "gist, read:org, repo" -> ["gist", "read:org", "repo"]
function parseScopes(scopes: unknown): Array<string> {
  if (typeof scopes !== "string") return []
  return scopes
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

interface GhHostsJson {
  hosts?: Record<
    string,
    Array<{
      login?: string
      host?: string
      active?: boolean
      scopes?: string
      state?: string
    }>
  >
}

async function readGhAccounts(run: GhRunner): Promise<Array<GhAccount>> {
  const result = await run(["auth", "status", "--json", "hosts"])
  // Non-zero (not signed in, or gh too old for --json), empty, or not-found:
  // degrade to "no enumerable accounts" rather than failing the whole probe.
  if (result.notFound || result.code !== 0 || !result.stdout.trim()) return []

  let parsed: GhHostsJson
  try {
    parsed = JSON.parse(result.stdout) as GhHostsJson
  } catch {
    return []
  }

  const accounts: Array<GhAccount> = []
  for (const [host, entries] of Object.entries(parsed.hosts ?? {})) {
    for (const entry of entries) {
      if (entry.state && entry.state !== "success") continue
      if (typeof entry.login !== "string" || !entry.login) continue
      accounts.push({
        login: entry.login,
        host: entry.host ?? host,
        active: entry.active === true,
        scopes: parseScopes(entry.scopes),
      })
    }
  }
  return accounts
}

/**
 * Detect the local `gh` CLI and its signed-in accounts. Never throws —
 * everything degrades to `{ installed: false }` or `{ accounts: [] }` so the
 * UI hint can render unconditionally.
 */
export async function detectGhCli(
  run: GhRunner = defaultRunner,
): Promise<GhCliStatus> {
  const version = await run(["--version"]).catch(
    (): GhRunResult => ({
      stdout: "",
      stderr: "",
      code: 1,
      notFound: true,
    }),
  )
  if (version.notFound) {
    return { installed: false, version: null, accounts: [] }
  }

  const accounts = await readGhAccounts(run).catch(() => [])
  return {
    installed: true,
    version: parseVersion(version.stdout),
    accounts,
  }
}
