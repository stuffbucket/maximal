import { describe, expect, test } from "bun:test"

import { DeviceCodeResponseSchema } from "~/services/github/get-device-code"

/**
 * The device-code boundary is where a malformed response used to poison the
 * poll loop: `interval`/`expires_in` were cast (`as DeviceCodeResponse`), so a
 * missing/garbage value reached the loop as `undefined` → `NaN`, disabling the
 * self-expiry deadline (`Date.now() >= NaN` is always false) and making
 * `sleep(NaN)` spin. These tests pin the schema's guarantee: those two fields
 * are ALWAYS finite, non-negative numbers, regardless of what the wire sends.
 */
describe("DeviceCodeResponseSchema", () => {
  const base = {
    device_code: "dev-123",
    user_code: "WXYZ-1234",
    verification_uri: "https://github.com/login/device",
  }

  test("valid numbers pass through unchanged; unknown fields are kept", () => {
    const r = DeviceCodeResponseSchema.parse({
      ...base,
      interval: 7,
      expires_in: 600,
      verification_uri_complete:
        "https://github.com/login/device?user_code=WXYZ",
      some_new_github_field: "kept",
    })
    expect(r.interval).toBe(7)
    expect(r.expires_in).toBe(600)
    expect(r.verification_uri_complete).toContain("user_code")
    expect((r as Record<string, unknown>).some_new_github_field).toBe("kept")
  })

  test("absent interval/expires_in default to finite RFC values", () => {
    const r = DeviceCodeResponseSchema.parse({ ...base })
    expect(r.interval).toBe(5)
    expect(r.expires_in).toBe(900)
  })

  // The regression driver: every non-finite / wrong-type value must fall back to
  // a finite default so the poll loop's interval + deadline math can never NaN.
  for (const bad of [
    null,
    undefined,
    "5",
    Number.NaN,
    Infinity,
    -Infinity,
    -3,
  ]) {
    test(`garbage interval/expires_in (${String(bad)}) → finite default, never NaN`, () => {
      const r = DeviceCodeResponseSchema.parse({
        ...base,
        interval: bad,
        expires_in: bad,
      })
      expect(Number.isFinite(r.interval)).toBe(true)
      expect(Number.isFinite(r.expires_in)).toBe(true)
      expect(Number.isNaN(r.interval)).toBe(false)
      expect(r.interval).toBe(5)
      expect(r.expires_in).toBe(900)
    })
  }

  test("a response missing the required identifiers fails loudly", () => {
    // Without device_code/user_code/verification_uri there is no flow to run;
    // a clear parse error beats silently proceeding with undefined.
    expect(() =>
      DeviceCodeResponseSchema.parse({ interval: 5, expires_in: 900 }),
    ).toThrow()
  })
})
