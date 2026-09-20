import { describe, expect, it } from "bun:test"

import type { WebFetchToolDecl } from "~/routes/messages/web-tools/types"

import {
  checkFetchPolicy,
  isHostAllowed,
  newRequestState,
} from "~/routes/messages/web-tools/state"
import { TOOL_TYPE, TOOL_NAME } from "~/routes/messages/web-tools/vocab"

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

// web_fetch's checkFetchPolicy must apply the SAME spec-correct matcher
// (`isHostAllowed`) as web_search — subdomains auto-included, suffix
// lookalikes rejected, path entries matched on their host portion, and
// the legacy `*.`-glob form no longer specially honored.
function fetchState(policy: {
  allowed_domains?: Array<string>
  blocked_domains?: Array<string>
}): ReturnType<typeof newRequestState> {
  const decl: WebFetchToolDecl = {
    type: TOOL_TYPE.webFetch,
    name: TOOL_NAME.webFetch,
    ...policy,
  }
  return newRequestState([decl])
}

const checkFetch = (
  policy: Parameters<typeof fetchState>[0],
  url: string,
): boolean => checkFetchPolicy(fetchState(policy), { url }).ok

describe("checkFetchPolicy — domain policy", () => {
  it("blocks a subdomain of a blocked domain (subdomain inclusion)", () => {
    const policy = { blocked_domains: ["example.com"] }
    expect(checkFetch(policy, "https://example.com/x")).toBe(false)
    expect(checkFetch(policy, "https://tracker.example.com/x")).toBe(false)
    expect(checkFetch(policy, "https://other.com/x")).toBe(true)
  })

  it("allows subdomains of an allowlisted domain", () => {
    const policy = { allowed_domains: ["example.com"] }
    expect(checkFetch(policy, "https://example.com/x")).toBe(true)
    expect(checkFetch(policy, "https://docs.example.com/x")).toBe(true)
  })

  it("rejects suffix lookalikes under an allowlist", () => {
    const policy = { allowed_domains: ["example.com"] }
    // notexample.com is NOT covered by example.com (no dot boundary).
    expect(checkFetch(policy, "https://notexample.com/x")).toBe(false)
    expect(checkFetch(policy, "https://example.com.evil.com/x")).toBe(false)
  })

  it("matches a path-carrying allow entry on its host portion", () => {
    const policy = { allowed_domains: ["example.com/blog"] }
    expect(checkFetch(policy, "https://example.com/anything")).toBe(true)
    expect(checkFetch(policy, "https://docs.example.com/x")).toBe(true)
  })

  it("no longer honors the `*.`-glob form specially (behavior change)", () => {
    // Old `hostMatches` treated `*.example.com` as a glob suffix; the
    // spec-correct matcher splits on `/` and compares the literal host
    // `*.example.com`, so a real host never equals it and is not a
    // subdomain of it — the entry matches nothing.
    const allow = { allowed_domains: ["*.example.com"] }
    expect(checkFetch(allow, "https://docs.example.com/x")).toBe(false)
    expect(checkFetch(allow, "https://example.com/x")).toBe(false)

    // Symmetrically, a `*.`-glob blocklist entry no longer blocks the
    // subdomains it used to — declare the bare domain instead.
    const block = { blocked_domains: ["*.example.com"] }
    expect(checkFetch(block, "https://docs.example.com/x")).toBe(true)
  })

  it("allows any host when no domain policy is declared", () => {
    expect(checkFetch({}, "https://anything.example/x")).toBe(true)
  })
})
