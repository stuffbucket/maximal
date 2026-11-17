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
 *   0600). The marker alone can't confirm or brute-force a key, even a
 *   short one a person chose; only this profile can check that the key it
 *   would write now is the one it wrote then.
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

/** This profile's marker secret, created on first use. Null when it can't
 *  be read or created safely: the marker then records no key evidence. */
function markerSecret(create: boolean): string | null {
  const file = path.join(secretsDir(), MARKER_SECRET_FILE)
  try {
    const existing = fs.readFileSync(file, "utf8").trim()
    return SECRET_PATTERN.test(existing) ? existing : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
      return null
    }
  }
  try {
    ensureSecretsDir(secretsDir())
    const secret = randomBytes(32).toString("hex")
    fs.writeFileSync(file, `${secret}\n`, { mode: 0o600, flag: "wx" })
    return secret
  } catch {
    return markerSecret(false)
  }
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
