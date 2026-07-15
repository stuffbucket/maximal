/**
 * Network-failure diagnosis for the auth path.
 *
 * These tests drive the classifier with injected probe results (no real
 * sockets/DNS) so they're deterministic and offline-safe, and pin the
 * transport-error detection against the exact shapes observed in the wild:
 * Bun's `{ code, path, errno }` fetch error, node/undici `TypeError: fetch
 * failed` with a nested `.cause`, and `AbortSignal.timeout`'s `TimeoutError`.
 */

import { afterEach, describe, expect, test } from "bun:test"

import {
  __resetNetworkDiagnosisCacheForTests,
  classifyNetworkFailure,
  defaultDnsLookup,
  defaultTcpConnect,
  diagnoseNetworkError,
  formatDiagnosisForLog,
  formatTransportError,
  getLastNetworkDiagnosis,
  hostFromUrl,
  HTTPS_PORT,
  IP_FAMILY,
  isDnsFailure,
  isOffline,
  isScopeUnreachable,
  isTransportError,
  NETWORK_SCOPE,
  probeNetwork,
  summarizeTransportError,
  type NetworkProbe,
} from "~/lib/net/network-diagnostics"

import {
  deadResolver,
  GUARANTEED_NXDOMAIN_HOST,
  GUARANTEED_NXDOMAIN_URL,
  healthyResolver,
  RESERVED_RESOLVABLE_HOST,
  RESERVED_RESOLVABLE_URL,
  UNREACHABLE_TARGETS,
} from "./helpers/rfc-network-fixtures"

afterEach(() => {
  __resetNetworkDiagnosisCacheForTests()
})

/** The exact Bun fetch error shape maximal logs when the auth endpoint drops. */
const bunConnRefused = () =>
  Object.assign(new Error("ConnectionRefused"), {
    code: "ConnectionRefused",
    path: RESERVED_RESOLVABLE_URL,
    errno: 0,
  })

const nodeFetchFailed = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      syscall: "connect",
      errno: -61,
    }),
  })

const okProbe: NetworkProbe = {
  ipReachable: true,
  ipv4Reachable: true,
  ipv6Reachable: false,
  dnsResolves: true,
  activeInterfaces: ["en0"],
}

describe("isTransportError", () => {
  test("recognises the Bun { code, path, errno } shape", () => {
    expect(isTransportError(bunConnRefused())).toBe(true)
  })

  test("recognises a Bun path/errno shape carrying a code we don't enumerate", () => {
    // A future/unknown Bun socket code absent from TRANSPORT_ERROR_CODES must
    // still be caught by the structural `"path" in rec && "errno" in rec`
    // fallback — otherwise a novel transport failure would be misread as an
    // application error. bunConnRefused()'s code is in the known set, so it
    // exercises the code-set branch, not this one.
    const novel = Object.assign(new Error("SomeNewBunSocketFailure"), {
      code: "SomeNewBunSocketFailure",
      path: RESERVED_RESOLVABLE_URL,
      errno: 0,
    })
    expect(isTransportError(novel)).toBe(true)
  })

  test("recognises node/undici 'fetch failed' via nested cause", () => {
    expect(isTransportError(nodeFetchFailed())).toBe(true)
  })

  test("recognises AbortSignal.timeout's TimeoutError", () => {
    expect(
      isTransportError({ name: "TimeoutError", message: "timed out" }),
    ).toBe(true)
  })

  test("does NOT treat a deliberate AbortError as a transport failure", () => {
    expect(isTransportError({ name: "AbortError", message: "aborted" })).toBe(
      false,
    )
  })

  test("does NOT treat an HTTP/application error as transport", () => {
    expect(isTransportError(new Error("Bad credentials"))).toBe(false)
    expect(isTransportError({ status: 401, message: "unauthorized" })).toBe(
      false,
    )
    expect(isTransportError(null)).toBe(false)
    expect(isTransportError("boom")).toBe(false)
  })
})

describe("summarizeTransportError / formatTransportError", () => {
  test("pulls url from Bun's `path` and renders a safe one-liner", () => {
    const s = summarizeTransportError(bunConnRefused())
    expect(s.code).toBe("ConnectionRefused")
    expect(s.url).toBe(RESERVED_RESOLVABLE_URL)
    expect(s.errno).toBe(0)
    const line = formatTransportError(s)
    expect(line).toContain("code=ConnectionRefused")
    expect(line).toContain(`url=${RESERVED_RESOLVABLE_URL}`)
    // errno 0 is falsy but a real value — pin that it renders, so a regression
    // to a truthy `if (summary.errno)` guard (which would drop the common Bun
    // ConnectionRefused errno:0) is caught.
    expect(line).toContain("errno=0")
  })

  test("unwraps a nested node cause for code/syscall", () => {
    const s = summarizeTransportError(nodeFetchFailed())
    expect(s.code).toBe("ECONNREFUSED")
    expect(s.syscall).toBe("connect")
    expect(formatTransportError(s)).toContain("syscall=connect")
  })
})

describe("classifyNetworkFailure", () => {
  const summary = summarizeTransportError(bunConnRefused())

  test("no IP egress -> offline (typed, no prose)", () => {
    const d = classifyNetworkFailure(
      summary,
      { ...okProbe, ipReachable: false, ipv4Reachable: false },
      NETWORK_SCOPE.githubCopilotAuth,
    )
    expect(d.kind).toBe("offline")
    expect(d.scope).toBe(NETWORK_SCOPE.githubCopilotAuth)
    // Typed verdict carries NO user-facing prose — i18n happens in the UI.
    expect(d).not.toHaveProperty("message")
  })

  test("IP ok but DNS broken -> dns-failure", () => {
    const d = classifyNetworkFailure(summary, {
      ...okProbe,
      dnsResolves: false,
    })
    expect(d.kind).toBe("dns-failure")
    expect(d.scope).toBeNull()
  })

  test("IP + DNS ok but scope failed -> scope-unreachable, scope echoed", () => {
    const d = classifyNetworkFailure(
      summary,
      okProbe,
      NETWORK_SCOPE.githubCopilotAuth,
    )
    expect(d.kind).toBe("scope-unreachable")
    expect(d.scope).toBe(NETWORK_SCOPE.githubCopilotAuth)
    // No baked-in cause/prose: the diagnosis is a typed value only.
    expect(d).not.toHaveProperty("message")
  })

  test("interface count is exposed as typed data, not prose", () => {
    const d = classifyNetworkFailure(summary, {
      ...okProbe,
      activeInterfaces: ["en0", "utun3"],
    })
    expect(d.probe.activeInterfaces).toEqual(["en0", "utun3"])
  })
})

describe("probeNetwork", () => {
  test("aggregates injected TCP/DNS/interface results", async () => {
    const probe = await probeNetwork(
      {
        tcpConnect: (_host, _port, family) =>
          Promise.resolve(family === IP_FAMILY.v4),
        dnsLookup: () => Promise.resolve(true),
        interfaces: () => ["en0"],
      },
      [RESERVED_RESOLVABLE_HOST],
    )
    expect(probe.ipv4Reachable).toBe(true)
    expect(probe.ipv6Reachable).toBe(false)
    expect(probe.ipReachable).toBe(true)
    expect(probe.dnsResolves).toBe(true)
    expect(probe.activeInterfaces).toEqual(["en0"])
  })

  test("treats DNS as working when no target host is supplied", async () => {
    const probe = await probeNetwork({
      tcpConnect: () => Promise.resolve(true),
      dnsLookup: () => Promise.resolve(false),
      interfaces: () => ["en0"],
    })
    // No host to probe -> can't disprove DNS, so don't flag dns-failure.
    expect(probe.dnsResolves).toBe(true)
  })
})

describe("kind predicates (rot-free interpretation)", () => {
  const summary = summarizeTransportError(bunConnRefused())
  const at = (probe: NetworkProbe) => classifyNetworkFailure(summary, probe)

  test("callers interpret a verdict without comparing raw strings", () => {
    const offline = at({ ...okProbe, ipReachable: false })
    expect(isOffline(offline)).toBe(true)
    expect(isDnsFailure(offline)).toBe(false)

    const dns = at({ ...okProbe, dnsResolves: false })
    expect(isDnsFailure(dns)).toBe(true)
    expect(isScopeUnreachable(dns)).toBe(false)

    const scope = at(okProbe)
    expect(isScopeUnreachable(scope)).toBe(true)
    expect(isOffline(scope)).toBe(false)
  })
})

describe("hostFromUrl", () => {
  test("extracts the host from an absolute URL", () => {
    expect(hostFromUrl(RESERVED_RESOLVABLE_URL)).toBe(RESERVED_RESOLVABLE_HOST)
  })

  test("returns null for missing / unparseable input", () => {
    expect(hostFromUrl(null)).toBeNull()
    expect(hostFromUrl("")).toBeNull()
    expect(hostFromUrl("not a url")).toBeNull()
  })
})

describe("diagnoseNetworkError caching", () => {
  test("re-uses the probe within the cache window, re-probes after", async () => {
    let probes = 0
    const deps = {
      tcpConnect: () => {
        probes++
        return Promise.resolve(true)
      },
      dnsLookup: () => Promise.resolve(true),
      interfaces: () => ["en0"],
    }
    let clock = 1_000_000
    const now = () => clock

    const first = await diagnoseNetworkError(bunConnRefused(), {
      ...deps,
      now,
      target: {
        scope: NETWORK_SCOPE.githubCopilotAuth,
        url: RESERVED_RESOLVABLE_URL,
      },
    })
    expect(first.kind).toBe("scope-unreachable")
    expect(first.scope).toBe(NETWORK_SCOPE.githubCopilotAuth)
    const afterFirst = probes
    expect(afterFirst).toBeGreaterThan(0)

    // Within 60s window: no new probes, but the per-call fields (scope +
    // summary) are still refreshed from THIS call, not served stale from the
    // cached verdict. Pass a different error (node ECONNREFUSED vs the first
    // call's Bun ConnectionRefused) so the assertion can tell a real refresh
    // apart from a branch that returns the stale cached summary.
    clock += 30_000
    const cached = await diagnoseNetworkError(nodeFetchFailed(), {
      ...deps,
      now,
      target: {
        scope: NETWORK_SCOPE.githubCopilotAuth,
        url: RESERVED_RESOLVABLE_URL,
      },
    })
    expect(probes).toBe(afterFirst)
    expect(cached.scope).toBe(NETWORK_SCOPE.githubCopilotAuth)
    expect(cached.summary.code).toBe("ECONNREFUSED")

    // Past the window: probes again.
    clock += 40_000
    await diagnoseNetworkError(bunConnRefused(), { ...deps, now })
    expect(probes).toBeGreaterThan(afterFirst)
  })

  test("getLastNetworkDiagnosis exposes the latest verdict, null after reset", () => {
    expect(getLastNetworkDiagnosis()).toBeNull()
  })

  test("getLastNetworkDiagnosis returns the cached diagnosis after a probe", async () => {
    await diagnoseNetworkError(bunConnRefused(), {
      tcpConnect: () => Promise.resolve(true),
      dnsLookup: () => Promise.resolve(true),
      interfaces: () => ["en0"],
      target: {
        scope: NETWORK_SCOPE.githubCopilotAuth,
        url: RESERVED_RESOLVABLE_URL,
      },
    })
    expect(getLastNetworkDiagnosis()?.kind).toBe("scope-unreachable")
  })
})

describe("formatDiagnosisForLog", () => {
  test("renders a plain dev-log line from the typed verdict", () => {
    const d = classifyNetworkFailure(
      summarizeTransportError(bunConnRefused()),
      {
        ipReachable: true,
        ipv4Reachable: true,
        ipv6Reachable: false,
        dnsResolves: true,
        activeInterfaces: ["en0", "utun3"],
      },
      NETWORK_SCOPE.githubCopilotAuth,
    )
    const line = formatDiagnosisForLog(d)
    expect(line).toContain("scope-unreachable")
    expect(line).toContain("scope=github-copilot-auth")
    expect(line).toContain("ip=ok")
    expect(line).toContain("dns=ok")
    expect(line).toContain("ifaces=2")
    expect(line).toContain("code=ConnectionRefused")
  })
})

/**
 * End-to-end scenarios driven by IETF-reserved fixtures (see
 * `helpers/rfc-network-fixtures.ts`). Still deterministic and offline: the
 * probe DI seam injects the behavior each RFC guarantees, so every case maps to
 * a value whose real-world outcome is defined by a standard.
 */
describe("real-world scenarios (RFC-reserved fixtures, deterministic)", () => {
  const healthyEgress = { tcpConnect: () => Promise.resolve(true) }

  test("the incident shape: a resolvable, reachable host but the scope endpoint drops -> scope-unreachable", async () => {
    // The target host resolves (RFC 2606 invariant) and raw egress works; only
    // the scope's own socket never completes — the shape maximal logged. We
    // pin this to a reserved host, not the live token URL, whose reachability
    // flips once the incident clears.
    const diag = await diagnoseNetworkError(bunConnRefused(), {
      ...healthyEgress,
      dnsLookup: healthyResolver,
      interfaces: () => ["en0"],
      target: {
        scope: NETWORK_SCOPE.githubCopilotAuth,
        url: RESERVED_RESOLVABLE_URL,
      },
    })
    expect(isScopeUnreachable(diag)).toBe(true)
    expect(diag.scope).toBe(NETWORK_SCOPE.githubCopilotAuth)
  })

  test("no raw egress at all -> offline", async () => {
    const diag = await diagnoseNetworkError(bunConnRefused(), {
      tcpConnect: () => Promise.resolve(false),
      dnsLookup: deadResolver,
      interfaces: () => [],
      target: {
        scope: NETWORK_SCOPE.githubCopilotAuth,
        url: RESERVED_RESOLVABLE_URL,
      },
    })
    expect(isOffline(diag)).toBe(true)
  })

  test("egress works but the resolver is down -> dns-failure", async () => {
    const diag = await diagnoseNetworkError(bunConnRefused(), {
      ...healthyEgress,
      dnsLookup: deadResolver,
      interfaces: () => ["en0"],
      target: {
        scope: NETWORK_SCOPE.githubCopilotAuth,
        url: RESERVED_RESOLVABLE_URL,
      },
    })
    expect(isDnsFailure(diag)).toBe(true)
  })

  test("a caller-supplied .invalid target (NXDOMAIN) -> dns-failure", async () => {
    // The library resolves the host from the *caller's* URL. A working resolver
    // (healthyResolver) returns NXDOMAIN for the RFC 6761 `.invalid` name.
    const diag = await diagnoseNetworkError(bunConnRefused(), {
      ...healthyEgress,
      dnsLookup: healthyResolver,
      interfaces: () => ["en0"],
      target: {
        scope: NETWORK_SCOPE.githubCopilotAuth,
        url: GUARANTEED_NXDOMAIN_URL,
      },
    })
    expect(isDnsFailure(diag)).toBe(true)
  })

  test("probe differentiates a nonexistent name from a dead resolver", async () => {
    // Same *working* resolver for both: the reserved RFC 2606 host resolves,
    // the RFC 6761 `.invalid` host does not — proving DNS itself is alive.
    const up = { ...healthyEgress, dnsLookup: healthyResolver }
    expect(
      (await probeNetwork(up, [RESERVED_RESOLVABLE_HOST])).dnsResolves,
    ).toBe(true)
    expect(
      (await probeNetwork(up, [GUARANTEED_NXDOMAIN_HOST])).dnsResolves,
    ).toBe(false)

    // A dead resolver, by contrast, fails even the reserved anchor.
    const down = { ...healthyEgress, dnsLookup: deadResolver }
    expect(
      (await probeNetwork(down, [RESERVED_RESOLVABLE_HOST])).dnsResolves,
    ).toBe(false)
  })
})

/**
 * Opt-in real-network validation. Skipped by default so the suite stays
 * deterministic and offline (the project convention). Set MAXIMAL_NETWORK_TESTS=1
 * to dial the real probe primitives against IETF-reserved endpoints and confirm
 * they observe the RFC-guaranteed outcomes the deterministic suite assumes.
 */
const RUN_REAL_NETWORK = Boolean(process.env.MAXIMAL_NETWORK_TESTS)
describe.skipIf(!RUN_REAL_NETWORK)(
  "real network probes (opt-in: MAXIMAL_NETWORK_TESTS=1)",
  () => {
    test("defaultDnsLookup resolves the RFC 2606 reserved host", async () => {
      expect(await defaultDnsLookup(RESERVED_RESOLVABLE_HOST)).toBe(true)
    })

    test("defaultDnsLookup returns false for an RFC 6761 .invalid host (NXDOMAIN)", async () => {
      expect(await defaultDnsLookup(GUARANTEED_NXDOMAIN_HOST)).toBe(false)
    })

    test("a live resolver distinguishes a nonexistent name from DNS being down", async () => {
      const [good, bad] = await Promise.all([
        defaultDnsLookup(RESERVED_RESOLVABLE_HOST),
        defaultDnsLookup(GUARANTEED_NXDOMAIN_HOST),
      ])
      expect(good).toBe(true)
      expect(bad).toBe(false)
    })

    test("defaultTcpConnect fails against RFC 5737/3849 documentation IPs", async () => {
      const results = await Promise.all(
        UNREACHABLE_TARGETS.map((t) =>
          defaultTcpConnect(t.host, HTTPS_PORT, t.family),
        ),
      )
      expect(results.every((ok) => !ok)).toBe(true)
    })

    test("probeNetwork observes DNS liveness through the real resolver", async () => {
      expect(
        (await probeNetwork({}, [RESERVED_RESOLVABLE_HOST])).dnsResolves,
      ).toBe(true)
      expect(
        (await probeNetwork({}, [GUARANTEED_NXDOMAIN_HOST])).dnsResolves,
      ).toBe(false)
    })
  },
)
