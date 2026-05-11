/**
 * File-based secrets loader.
 *
 * Reads provider keys from `~/.local/share/maximal/secrets/<name>`.
 * Env vars still win — this is a fallback for "I don't want my API
 * key in shell history."
 *
 * Format: one key value per file, trailing whitespace stripped. The
 * file must be mode 0600; broader modes are warned about and skipped
 * (the proxy refuses to read a key that any other user can read).
 *
 * The directory is created on first read with mode 0700 if absent.
 *
 * `SECRET_DEFS` is the canonical list of known secrets — boot
 * loader, debug subcommand, and `/_debug/state` all iterate this
 * table so adding a third provider is a one-line change.
 */

import consola from "consola"
import fs from "node:fs"
import path from "node:path"

import { PATHS } from "./paths"

const SECRETS_DIR = path.join(PATHS.APP_DIR, "secrets")
const SAFE_FILE_MODE = 0o600
const SAFE_DIR_MODE = 0o700

export type SecretSource = "env" | "file" | "unset"

export interface SecretRead {
  /** The resolved value, or undefined if neither source produced one. */
  value: string | undefined
  /** Where the value came from. */
  source: SecretSource
  /** Diagnostic message about file-mode warnings, etc. Used by debug
   *  subcommand and /_debug/state. Empty when there's nothing to say. */
  diagnostic?: string
}

/** Read a secret with env > file > unset precedence. The env-var name
 *  and file name are separate; conventionally the env is uppercase
 *  (`OLLAMA_API_KEY`) and the file is the provider name lowercase
 *  (`ollama`). */
export function readSecret(opts: {
  envVar: string
  fileName: string
  /** Override env source (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Override the secrets dir (tests). */
  dir?: string
}): SecretRead {
  const env = opts.env ?? process.env
  const envVal = env[opts.envVar]
  if (envVal !== undefined && envVal.length > 0) {
    return { value: envVal, source: "env" }
  }

  const dir = opts.dir ?? SECRETS_DIR
  const file = path.join(dir, opts.fileName)

  // Open once and operate on the fd to avoid a TOCTOU race between the
  // mode check and the read. ENOENT on openSync → "unset"; any other
  // open failure → "unset" (best effort, treat as unreadable).
  let fd: number
  try {
    // O_NOFOLLOW refuses to traverse symlinks so a planted symlink under
    // any dir (including tmp) can't redirect the read.
    // lgtm[js/insecure-temporary-file] — false positive: the taint flow
    // CodeQL sees comes from test fixtures passing os.tmpdir()-derived
    // paths into opts.dir. Production SECRETS_DIR resolves to
    // ~/.local/share/copilot-api/secrets/, never to a temp dir.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch {
    return { value: undefined, source: "unset" }
  }

  try {
    const stats = fs.fstatSync(fd)

    if (!stats.isFile()) {
      return {
        value: undefined,
        source: "unset",
        diagnostic: `${file} is not a regular file; ignored`,
      }
    }

    // POSIX file mode lives in the lower 9 bits of stats.mode. We only
    // tolerate 0600 (or stricter — but that's rare). Anything broader
    // means group or world can read; refuse so a drive-by chmod doesn't
    // turn into a credential leak.
    const mode = stats.mode & 0o777
    if (mode !== SAFE_FILE_MODE) {
      const msg = `${file} has insecure mode ${mode.toString(8).padStart(3, "0")} (expected 600); skipped`
      consola.warn(msg)
      return { value: undefined, source: "unset", diagnostic: msg }
    }

    let value: string
    try {
      value = fs.readFileSync(fd, "utf8").trim()
    } catch {
      return {
        value: undefined,
        source: "unset",
        diagnostic: `${file} could not be read`,
      }
    }
    if (value.length === 0) {
      return { value: undefined, source: "unset" }
    }
    return { value, source: "file" }
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* best effort */
    }
  }
}

/** Materialize a secret into process.env if not already present.
 *  Used by the boot sequence so the rest of the codebase (existing
 *  process.env reads in selectExecutor, debug, etc.) keeps working
 *  without per-call rewiring. */
export function loadSecretIntoEnv(opts: {
  envVar: string
  fileName: string
}): SecretRead {
  const r = readSecret(opts)
  if (r.source === "file" && r.value !== undefined) {
    process.env[opts.envVar] = r.value
  }
  return r
}

/** Ensure the secrets dir exists with safe perms. Creates with
 *  0o700 if absent. Idempotent. */
export function ensureSecretsDir(dir: string = SECRETS_DIR): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: SAFE_DIR_MODE })
  } catch {
    /* best effort — caller will see ENOENT or EACCES on read */
  }
}

/** @public Surfaced in `debug` output and external tooling for the secrets dir path. */
export const SECRETS_PATHS = {
  DIR: SECRETS_DIR,
}

/** Canonical list of known secrets. Extend here, not at call sites. */
export interface SecretDef {
  /** Display name for diagnostic output (`debug`, `/_debug/state`). */
  name: string
  envVar: string
  fileName: string
  /** Optional read-back of the value from AppConfig — only some
   *  secrets (e.g. `anthropicApiKey`) have a config-tier fallback. */
  readConfig?: (config: { anthropicApiKey?: string }) => string | undefined
}

export const SECRET_DEFS: ReadonlyArray<SecretDef> = [
  { name: "ollama_api_key", envVar: "OLLAMA_API_KEY", fileName: "ollama" },
  {
    name: "anthropic_api_key",
    envVar: "ANTHROPIC_API_KEY",
    fileName: "anthropic",
    readConfig: (c) => c.anthropicApiKey,
  },
]

/** Returns true if the on-disk secrets file matches `value` and is
 *  mode 0600. Used by debug surfaces to distinguish env-from-file
 *  from env-from-shell. Best-effort — any I/O error → false. */
export function secretIsFromFile(fileName: string, value: string): boolean {
  const filePath = path.join(SECRETS_DIR, fileName)
  let fd: number
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch {
    return false
  }
  try {
    const stats = fs.fstatSync(fd)
    if (!stats.isFile()) return false
    if ((stats.mode & 0o777) !== SAFE_FILE_MODE) return false
    return fs.readFileSync(fd, "utf8").trim() === value
  } catch {
    return false
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* best effort */
    }
  }
}
