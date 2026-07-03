import { describe, expect, it } from "bun:test"

import { isHostAllowed } from "~/routes/messages/web-tools/state"

// Anthropic web-tool domain-policy semantics (server-tools spec):
// subdomains of a listed domain are auto-included; allowed/blocked are
// mutually exclusive; a listed path entry matches on its host portion.
describe("isHostAllowed", () => {
  it("allows the exact host and its subdomains under an allowlist", () => {
    const policy = { allowed_domains: ["example.com"] }
    expect(isHostAllowed("example.com", policy)).toBe(true)
    expect(isHostAllowed("docs.example.com", policy)).toBe(true)
    expect(isHostAllowed("a.b.example.com", policy)).toBe(true)
  })

  it("denies hosts outside the allowlist", () => {
    const policy = { allowed_domains: ["example.com"] }
    expect(isHostAllowed("evil.com", policy)).toBe(false)
    // Not a subdomain — a suffix lookalike must NOT match.
    expect(isHostAllowed("notexample.com", policy)).toBe(false)
    expect(isHostAllowed("example.com.evil.com", policy)).toBe(false)
  })

  it("restricts to a specific subdomain when one is listed", () => {
    const policy = { allowed_domains: ["docs.example.com"] }
    expect(isHostAllowed("docs.example.com", policy)).toBe(true)
    expect(isHostAllowed("api.example.com", policy)).toBe(false)
    expect(isHostAllowed("example.com", policy)).toBe(false)
  })

  it("blocks a host and its subdomains under a blocklist", () => {
    const policy = { blocked_domains: ["spam.example"] }
    expect(isHostAllowed("spam.example", policy)).toBe(false)
    expect(isHostAllowed("mail.spam.example", policy)).toBe(false)
    expect(isHostAllowed("legit.example", policy)).toBe(true)
  })

  it("matches on the host portion when the entry carries a path", () => {
    const policy = { allowed_domains: ["example.com/blog"] }
    expect(isHostAllowed("example.com", policy)).toBe(true)
  })

  it("allows everything when no policy is set", () => {
    expect(isHostAllowed("anything.example", {})).toBe(true)
  })
})
