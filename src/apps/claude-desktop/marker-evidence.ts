/**
 * Evidence, kept in the routing marker, that Claude Desktop's copy of
 * Maximal's profile is still Maximal's after Claude rewrote it.
 *
 * Claude replaces the plaintext gateway key Maximal writes with its own
 * sealed form (`__sealed__:v1:<base64>`), so the bytes, and the key, no
 * longer match anything Maximal wrote. The marker therefore records, at
 * write time:
 *
 * - `managedFingerprint`: SHA-256 of every field Maximal manages except the
 *   key, in Maximal's field order. Not secret.
 * - `keyFingerprint`: HMAC-SHA256 of the plaintext key under a random secret
 *   kept only in this Maximal profile's own `secrets/` directory (mode
 *   0600). It adds neither the key nor an unkeyed hash of it to the marker;
 *   only this profile can check that the key it would write now is the one
 *   it wrote then.
 *
 * The marker's older whole-file `fingerprint` (needed to notice edits) is an
 * unkeyed SHA-256 of the profile as written, key included, so a short key a
 * person chose could in principle be guessed from it. Keys Maximal generates
 * carry 192 random bits and can't be.
 *
 * Maximal never decodes the sealed value or touches the Keychain: the shape
 * check only recognizes Claude's at-rest form.
 */

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { ensureSecretsDir } from "~/lib/auth/secrets"
import { readFileNoFollow } from "~/lib/platform/atomic-json"
import { PATHS } from "~/lib/platform/paths"

const SEALED_TAG = "__sealed__:v1:"
/** The tag, then standard base64 (whole 4-character groups, optional
 *  padding) between 64 and 4096 characters. Anything else is not Claude's
 *  sealed form: plaintext, other tags, URL-safe alphabets, stray padding. */
const SEALED_KEY = new RegExp(
  String.raw`^${SEALED_TAG}(?:[A-Za-z0-9+/]{4}){15,1023}(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$`,
)

/** Is this exactly Claude's sealed at-rest form of a gateway key? */
export function isClaudeSealedKey(value: unknown): value is string {
  return typeof value === "string" && SEALED_KEY.test(value)
}

const KEY_FIELD = "inferenceGatewayApiKey"

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex")
}

/** SHA-256 of the file's exact bytes, the marker's `fingerprint`. */
export function fileFingerprint(file: string): string | null {
  try {
    return sha256(fs.readFileSync(file))
  } catch {
    return null
  }
}

/**
 * Does the profile still say what the marker recorded? Claude Desktop
 * rewrites library profiles in its own formatting (no trailing newline, and
 * possibly another key order), so besides the exact bytes, the parsed
 * content (`parsed`) serialized the way Maximal writes it also counts. Any
 * change to a value still breaks the match.
 */
export function fingerprintMatches(
  file: string,
  parsed: Record<string, unknown> | null,
  expected: { fingerprint: string; keyOrder: ReadonlyArray<string> },
): boolean {
  const { fingerprint, keyOrder } = expected
  if (fileFingerprint(file) === fingerprint) return true
  if (!parsed) return false
  const candidates: Array<Record<string, unknown>> = [parsed]
  if (
    Object.keys(parsed).length === keyOrder.length
    && keyOrder.every((key) => Object.hasOwn(parsed, key))
  ) {
    candidates.push(Object.fromEntries(keyOrder.map((k) => [k, parsed[k]])))
  }
  return candidates.some(
    (value) => sha256(`${JSON.stringify(value, null, 2)}\n`) === fingerprint,
  )
}

/** Fingerprint of every managed field except the key, in `keyOrder`. */
export function managedFingerprint(
  profile: Readonly<Record<string, unknown>>,
  keyOrder: ReadonlyArray<string>,
): string {
  const fields = keyOrder
    .filter((key) => key !== KEY_FIELD)
    .map((key) => [key, profile[key] ?? null])
  return createHash("sha256")
    .update("maximal-desktop-managed-v1\0")
    .update(JSON.stringify(fields))
    .digest("hex")
}

const MARKER_SECRET_FILE = "claude-desktop-marker"
const SECRET_PATTERN = /^[0-9a-f]{64}$/

function secretsDir(): string {
  return path.join(PATHS.APP_DIR, "secrets")
}

type SecretFile =
  | { kind: "valid"; secret: string }
  /** Missing, empty or corrupt (say, a crash mid-write): no evidence can
   *  verify against it, so it may be (re)created. */
  | { kind: "replaceable"; exists: boolean }
  /** A link or anything not a plain file: never used, never replaced. */
  | { kind: "unusable" }

function readSecretFile(file: string): SecretFile {
  let text: string | null
  try {
    text = readFileNoFollow(file, () => new Error("marker secret is a link"))
  } catch {
    return { kind: "unusable" }
  }
  if (text === null) return { kind: "replaceable", exists: false }
  try {
    if (!fs.lstatSync(file).isFile()) return { kind: "unusable" }
  } catch {
    return { kind: "unusable" }
  }
  const secret = text.trim()
  return SECRET_PATTERN.test(secret) ?
      { kind: "valid", secret }
    : { kind: "replaceable", exists: true }
}

/** This profile's marker secret, created (or recovered) on first use. Null
 *  when it can't be read or written safely: the marker then records no key
 *  evidence. A valid secret is never replaced. */
function markerSecret(create: boolean): string | null {
  const file = path.join(secretsDir(), MARKER_SECRET_FILE)
  const current = readSecretFile(file)
  if (current.kind === "valid") return current.secret
  if (current.kind === "unusable" || !create) return null
  try {
    ensureSecretsDir(secretsDir())
    const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
    fs.writeFileSync(temp, `${randomBytes(32).toString("hex")}\n`, {
      mode: 0o600,
      flag: "wx",
    })
    try {
      // Missing: link, so a concurrent creator's secret wins intact.
      // Corrupt: rename over it in one step.
      if (current.exists) fs.renameSync(temp, file)
      else fs.linkSync(temp, file)
    } catch {
      /* another process won; read its secret below */
    } finally {
      fs.rmSync(temp, { force: true })
    }
  } catch {
    return null
  }
  const written = readSecretFile(file)
  return written.kind === "valid" ? written.secret : null
}

function hmac(secret: string, key: string): string {
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update("maximal-desktop-key-v1\0")
    .update(key)
    .digest("hex")
}

/** The key evidence to record when writing `key`, or null if unavailable. */
export function keyFingerprintFor(key: string): string | null {
  if (key === "") return null
  const secret = markerSecret(true)
  return secret ? hmac(secret, key) : null
}

/** Does `fingerprint` say this profile wrote `key`? */
export function keyFingerprintMatches(
  fingerprint: string,
  key: string,
): boolean {
  const secret = markerSecret(false)
  if (secret === null || key === "" || !SECRET_PATTERN.test(fingerprint)) {
    return false
  }
  return timingSafeEqual(
    Buffer.from(hmac(secret, key), "hex"),
    Buffer.from(fingerprint, "hex"),
  )
}
