import { describe, expect, it } from "bun:test"

import { AppConfigSchema } from "~/lib/config/config-schema"

describe("logRetentionDays config", () => {
  it("accepts a positive integer", () => {
    const r = AppConfigSchema.safeParse({ logRetentionDays: 30 })
    expect(r.success).toBe(true)
  })

  it("accepts 0 (delete-on-cleanup-tick)", () => {
    const r = AppConfigSchema.safeParse({ logRetentionDays: 0 })
    expect(r.success).toBe(true)
  })

  it("rejects a negative value", () => {
    const r = AppConfigSchema.safeParse({ logRetentionDays: -1 })
    expect(r.success).toBe(false)
  })

  it("rejects a non-integer", () => {
    const r = AppConfigSchema.safeParse({ logRetentionDays: 1.5 })
    expect(r.success).toBe(false)
  })

  it("rejects unrealistically large values (> 3650 days / 10y)", () => {
    const r = AppConfigSchema.safeParse({ logRetentionDays: 4000 })
    expect(r.success).toBe(false)
  })

  it("is optional — omitting it parses successfully", () => {
    const r = AppConfigSchema.safeParse({})
    expect(r.success).toBe(true)
  })
})
