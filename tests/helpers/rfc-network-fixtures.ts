/**
 * Standards-backed network fixtures for the network-diagnostics tests.
 *
 * Real third-party hostnames and IPs drift — they can start or stop resolving,
 * get firewalled, or change routing — which makes any test that hard-codes them
 * flaky. The IETF reserves specific names and address blocks *precisely* so
 * documentation and test code have stable, guaranteed-behavior values. We use
 * those here, each tied to the RFC that guarantees its behavior, so:
 *
 *   - the deterministic (default) suite injects that behavior through the probe
 *     DI seam and reads like the live network, and
 *   - the opt-in real-network suite dials the very same fixtures and verifies
 *     the live probes actually observe the RFC-guaranteed outcome.
 *
 * References:
 *   - RFC 5737 — IPv4 Address Blocks Reserved for Documentation (TEST-NET-1/2/3)
 *   - RFC 3849 — IPv6 Address Prefix Reserved for Documentation (2001:DB8::/32)
 *   - RFC 2606 — Reserved Top Level DNS Names (`example.com`, `.invalid`, …)
 *   - RFC 6761 — Special-Use Domain Names (formalizes `.invalid` as NXDOMAIN)
 */

import { COPILOT_TOKEN_PATH } from "~/lib/config/api-config"
import { IP_FAMILY, type IpFamily } from "~/lib/net/network-diagnostics"

/**
 * RFC 5737 §3 — IPv4 blocks reserved for documentation. Guaranteed NOT to be
 * globally routed, so a real TCP connect attempt never completes (the packet is
 * dropped and the socket times out). Models "the box tried to reach an IP and
 * nothing answered".
 */
export const DOCUMENTATION_IPV4 = {
  /** 192.0.2.0/24 — TEST-NET-1 */
  testNet1: "192.0.2.1",
  /** 198.51.100.0/24 — TEST-NET-2 */
  testNet2: "198.51.100.1",
  /** 203.0.113.0/24 — TEST-NET-3 */
  testNet3: "203.0.113.1",
} as const

/**
 * RFC 3849 — IPv6 prefix reserved for documentation (2001:DB8::/32). Not routed;
 * a connect attempt fails the same way as the IPv4 documentation blocks.
 */
export const DOCUMENTATION_IPV6 = {
  primary: "2001:db8::1",
} as const

/**
 * RFC 6761 §6.4 — the `.invalid` TLD is guaranteed never to be delegated, so any
 * name under it resolves to NXDOMAIN. Models a *well-formed but nonexistent /
 * blocked domain name* — the resolver works and answers authoritatively that the
 * name does not exist. This is the value that lets a test tell "bad domain name"
 * apart from "DNS is down".
 */
export const GUARANTEED_NXDOMAIN_HOST = "copilot-auth.invalid"
export const GUARANTEED_NXDOMAIN_URL = `https://${GUARANTEED_NXDOMAIN_HOST}${COPILOT_TOKEN_PATH}`

/**
 * RFC 2606 §3 — `example.com` is reserved and maintained by IANA with live
 * A/AAAA records, so it resolves. This is an *invariant*: it resolves the same
 * way regardless of local network state or the incident under study. Used both
 * as the "is the resolver alive?" anchor and as a stand-in for *any host that
 * resolves and is reachable* — so a "reachable host, but this specific endpoint
 * dropped" scenario stays pinned to guaranteed behavior instead of a live host
 * (e.g. `api.github.com`) whose reachability flips once the incident clears.
 */
export const RESERVED_RESOLVABLE_HOST = "example.com"
export const RESERVED_RESOLVABLE_URL = `https://${RESERVED_RESOLVABLE_HOST}${COPILOT_TOKEN_PATH}`

/** RFC 5737/3849 reachability targets paired with their IP family, ready to feed
 *  the real `defaultTcpConnect`. All are guaranteed-unreachable. */
export const UNREACHABLE_TARGETS: ReadonlyArray<{
  host: string
  family: IpFamily
}> = [
  { host: DOCUMENTATION_IPV4.testNet1, family: IP_FAMILY.v4 },
  { host: DOCUMENTATION_IPV4.testNet2, family: IP_FAMILY.v4 },
  { host: DOCUMENTATION_IPV6.primary, family: IP_FAMILY.v6 },
]

/**
 * A host-aware DNS stub modelling a *healthy resolver*: it answers for the
 * RFC 2606 reserved host and returns NXDOMAIN (false) for the RFC 6761
 * `.invalid` host — exactly what a live resolver does. Injecting this proves the
 * probe distinguishes a nonexistent name from a dead resolver without touching
 * the network.
 */
export const healthyResolver = (host: string): Promise<boolean> =>
  Promise.resolve(host !== GUARANTEED_NXDOMAIN_HOST)

/** A DNS stub modelling a *dead / unreachable resolver*: every lookup fails,
 *  including the reserved anchor. */
export const deadResolver = (): Promise<boolean> => Promise.resolve(false)
