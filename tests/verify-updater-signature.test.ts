/**
 * The release gate that checks a desktop update's signature the way the apps
 * will (scripts/verify-updater-signature.ts): signed by the configured key,
 * covering the file, and bound to the release version.
 *
 * The fixture was signed with a throwaway key made for this test
 * (`tauri signer generate`, then `tauri signer sign --app-version 1.2.3`); its
 * private half was discarded. It is not Maximal's updater key.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

import {
  decodePublicKey,
  keyIdHex,
  verifyUpdaterSignature,
} from "../scripts/verify-updater-signature"

const TEST_PUBKEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEJCRkE1RkVDMjgxMTMxODQKUldTRU1SRW83Ri82dTJFRitaRTBoTjBwQkt2aEpwSW5mSVo5VThrMFc1L1ErTHJ4YzBSSGlMVHEK"
const TEST_SIG =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTRU1SRW83Ri82dTZzUVA4OFlOVlFrTFVCMzBITlM0ZDZaS1VTb3JiVnU3REJNdllFVTRnWEVtTEZCeGY4NkVvcURzTVZWTGF2OWlJbnhtQ0M5dHdGTlF1b0FtQmwwYlE0PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzMTQ4NDg1CWZpbGU6dXBkYXRlLmJpbgl2ZXJzaW9uOjEuMi4zCkx5cjdZSHBYZjZiT0N2bUxkbmVTTmpXNFBoMHpGK3BzcDR5L3RFQXdFRU5xdnphL1JNaEROekJBbG5mTk9uMlJqSzNUK1NIeitHWEVjR3Z6Sy80T0NnPT0K"
const DATA = new TextEncoder().encode("maximal updater signature fixture\n")

/** The signature with its trusted comment line replaced. */
function withTrustedComment(comment: string): string {
  const lines = Buffer.from(TEST_SIG, "base64").toString("utf8").split("\n")
  lines[2] = `trusted comment: ${comment}`
  return Buffer.from(lines.join("\n"), "utf8").toString("base64")
}

describe("verifyUpdaterSignature", () => {
  test("accepts the file, signed by the key, for the version", () => {
    expect(verifyUpdaterSignature(DATA, TEST_SIG, TEST_PUBKEY, "1.2.3")).toBe(
      "timestamp:1793148485\tfile:update.bin\tversion:1.2.3",
    )
    // A leading v on the expected version is ignored, as the app does.
    expect(() =>
      verifyUpdaterSignature(DATA, TEST_SIG, TEST_PUBKEY, "v1.2.3"),
    ).not.toThrow()
  })

  test("rejects another version", () => {
    expect(() =>
      verifyUpdaterSignature(DATA, TEST_SIG, TEST_PUBKEY, "1.2.4"),
    ).toThrow("signed for version 1.2.3, expected 1.2.4")
  })

  test("rejects a changed file", () => {
    const changed = new TextEncoder().encode(
      "maximal updater signature fixturE\n",
    )
    expect(() =>
      verifyUpdaterSignature(changed, TEST_SIG, TEST_PUBKEY, "1.2.3"),
    ).toThrow("does not match the file")
  })

  test("rejects a trusted comment edited to claim another version", () => {
    const forged = withTrustedComment(
      "timestamp:1793148485\tfile:update.bin\tversion:9.9.9",
    )
    expect(() =>
      verifyUpdaterSignature(DATA, forged, TEST_PUBKEY, "9.9.9"),
    ).toThrow("trusted comment is not covered")
  })

  test("rejects a signature by another key, naming both", () => {
    const config = JSON.parse(
      readFileSync(
        new URL("../shell/src-tauri/tauri.conf.json", import.meta.url),
        "utf8",
      ),
    ) as { plugins: { updater: { pubkey: string } } }
    expect(() =>
      verifyUpdaterSignature(
        DATA,
        TEST_SIG,
        config.plugins.updater.pubkey,
        "1.2.3",
      ),
    ).toThrow("signed with key BBFA5FEC28113184, expected E8DAB79E2EB1D6C4")
  })
})

describe("decodePublicKey", () => {
  test("reads the key id minisign prints", () => {
    expect(keyIdHex(decodePublicKey(TEST_PUBKEY).keyId)).toBe(
      "BBFA5FEC28113184",
    )
  })
})
