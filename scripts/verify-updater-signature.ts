#!/usr/bin/env bun
/**
 * Verify a desktop update's signature the way the apps will before a release
 * can publish: release.yml runs this on the Windows installer (`windows-shell`)
 * and the macOS app bundle (`macos-dmg`).
 *
 * The apps' updater (tauri-plugin-updater) accepts a file only when
 *   1. its minisign signature (`<file>.sig`, as `tauri build` or
 *      `tauri signer sign` wrote it) was made by the key in
 *      `plugins.updater.pubkey` of shell/src-tauri/tauri.conf.json, and
 *   2. the signature's trusted comment names the release version
 *      (`version:<X.Y.Z>`), because the app sets `requireSignedVersion`.
 * This checks both, so a wrongly signed file fails the release instead of
 * every user's update.
 *
 * Usage:
 *   bun scripts/verify-updater-signature.ts --file <path> --version <X.Y.Z>
 *     [--sig <path>]      (default: <file>.sig)
 *     [--config <path>]   (default: shell/src-tauri/tauri.conf.json)
 */

import { createHash, createPublicKey, verify } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"

/** Ed25519 public keys in DER (SPKI) form are this prefix + the 32 raw bytes. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

const TRUSTED_PREFIX = "trusted comment: "

const decodeBase64Text = (value: string): string =>
  Buffer.from(value.trim(), "base64").toString("utf8")

/** Line `index` (0-based) of a minisign key or signature box. */
function boxLine(box: string, index: number): string {
  const line = box.split(/\r?\n/u)[index]
  if (line === undefined) throw new Error(`missing line ${index + 1}`)
  return line
}

interface PublicKey {
  keyId: Buffer
  key: Buffer
}

/** Decode `plugins.updater.pubkey`: base64 of a minisign public key box. */
export function decodePublicKey(pubkey: string): PublicKey {
  const raw = Buffer.from(boxLine(decodeBase64Text(pubkey), 1), "base64")
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new Error("the public key is not a minisign Ed25519 key")
  }
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10, 42) }
}

/** The key id as minisign prints it (little-endian hex, upper case). */
export function keyIdHex(keyId: Buffer): string {
  return Buffer.from(keyId).reverse().toString("hex").toUpperCase()
}

const ed25519Verify = (key: Buffer, message: Buffer, signature: Buffer) =>
  verify(
    null,
    message,
    createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, key]),
      format: "der",
      type: "spki",
    }),
    signature,
  )

/**
 * Throw unless `signatureFile` (the `.sig` content) is a valid signature of
 * `data` by `pubkey`, bound to `version`. Returns the trusted comment.
 */
export function verifyUpdaterSignature(
  data: Uint8Array,
  signatureFile: string,
  pubkey: string,
  version: string,
): string {
  const { keyId, key } = decodePublicKey(pubkey)
  const box = decodeBase64Text(signatureFile)
  const sig = Buffer.from(boxLine(box, 1), "base64")
  const trustedLine = boxLine(box, 2)
  const globalSig = Buffer.from(boxLine(box, 3), "base64")
  if (sig.length !== 74 || globalSig.length !== 64) {
    throw new Error("the signature is not a minisign signature")
  }
  if (!trustedLine.startsWith(TRUSTED_PREFIX)) {
    throw new Error("the signature has no trusted comment")
  }
  const algorithm = sig.subarray(0, 2).toString("latin1")
  if (algorithm !== "ED" && algorithm !== "Ed") {
    throw new Error(`unsupported signature algorithm ${algorithm}`)
  }
  if (!sig.subarray(2, 10).equals(keyId)) {
    throw new Error(
      `signed with key ${keyIdHex(sig.subarray(2, 10))}, expected ${keyIdHex(keyId)}`,
    )
  }
  // "ED" signs the BLAKE2b-512 hash of the file; legacy "Ed" signs the file.
  const message =
    algorithm === "ED" ?
      createHash("blake2b512").update(data).digest()
    : Buffer.from(data)
  if (!ed25519Verify(key, message, sig.subarray(10))) {
    throw new Error("the signature does not match the file")
  }
  const trusted = trustedLine.slice(TRUSTED_PREFIX.length)
  if (
    !ed25519Verify(
      key,
      Buffer.concat([sig.subarray(10), Buffer.from(trusted, "utf8")]),
      globalSig,
    )
  ) {
    throw new Error("the trusted comment is not covered by the signature")
  }
  const signedVersion = trusted
    .split("\t")
    .find((field) => field.startsWith("version:"))
    ?.slice("version:".length)
  const expected = version.replace(/^v/u, "")
  if (signedVersion !== expected) {
    throw new Error(
      `signed for version ${signedVersion ?? "(none)"}, expected ${expected}`,
    )
  }
  return trusted
}

function arg(argv: Array<string>, flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

function main(argv: Array<string>): number {
  const file = arg(argv, "--file")
  const version = arg(argv, "--version")
  if (!file || !version) {
    console.error(
      "usage: verify-updater-signature.ts --file <path> --version <X.Y.Z> [--sig <path>] [--config <tauri.conf.json>]",
    )
    return 2
  }
  const sigPath = arg(argv, "--sig") ?? `${file}.sig`
  const configPath =
    arg(argv, "--config") ??
    path.join(import.meta.dir, "..", "shell", "src-tauri", "tauri.conf.json")
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    plugins?: { updater?: { pubkey?: unknown } }
  }
  const pubkey = config.plugins?.updater?.pubkey
  if (typeof pubkey !== "string" || pubkey.length === 0) {
    console.error(`no plugins.updater.pubkey in ${configPath}`)
    return 1
  }
  try {
    const trusted = verifyUpdaterSignature(
      readFileSync(file),
      readFileSync(sigPath, "utf8"),
      pubkey,
      version,
    )
    console.log(
      `${path.basename(file)}: signed by ${keyIdHex(decodePublicKey(pubkey).keyId)} for ${version} (${trusted})`,
    )
    return 0
  } catch (err) {
    console.error(
      `${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return 1
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
