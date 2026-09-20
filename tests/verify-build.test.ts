import { describe, expect, it } from "bun:test"

import {
  assessConfigFlags,
  decideVerdict,
  extractSha,
  parseArgs,
  resolveConfigPath,
  shaMatches,
  verifyBuild,
  type ShaComparison,
  type VerifyDeps,
} from "../scripts/dev/verify-build"

describe("extractSha", () => {
  it("pulls the +<sha8> suffix from a dev version header", () => {
    expect(extractSha("0.4.39-dev+7856b665")).toBe("7856b665")
  })

  it("lower-cases the sha", () => {
    expect(extractSha("0.4.39-dev+7856B665")).toBe("7856b665")
  })

  it("returns null for a release build with no +<sha> suffix", () => {
    expect(extractSha("0.4.39")).toBeNull()
  })

  it("returns null for null / non-string input", () => {
    expect(extractSha(null)).toBeNull()
    expect(extractSha(undefined)).toBeNull()
  })

  it("returns null when the suffix is not hex", () => {
    expect(extractSha("0.4.39-dev+notasha!!")).toBeNull()
  })
})

describe("shaMatches", () => {
  it("treats an 8-char and a 7-char prefix as equal", () => {
    expect(shaMatches("e3fffce8", "e3fffce")).toBe(true)
    expect(shaMatches("e3fffce", "e3fffce8")).toBe(true)
  })

  it("is case-insensitive", () => {
    expect(shaMatches("E3FFFCE8", "e3fffce")).toBe(true)
  })

  it("rejects unrelated shas", () => {
    expect(shaMatches("7856b665", "e3fffce8")).toBe(false)
  })
})

describe("decideVerdict", () => {
  const ancestor: ShaComparison = { isAncestor: true, behind: 5 }

  it("PASS when running sha matches origin/main", () => {
    const v = decideVerdict({
      runningSha: "e3fffce8",
      originSha: "e3fffce",
      comparison: null,
    })
    expect(v.verdict).toBe("PASS")
    expect(v.message).toContain("e3fffce8")
  })

  it("STALE when running is an ancestor N commits behind", () => {
    const v = decideVerdict({
      runningSha: "7856b665",
      originSha: "e3fffce8",
      comparison: ancestor,
    })
    expect(v.verdict).toBe("STALE")
    expect(v.message).toContain("5 commits behind")
    expect(v.message).toContain("app:dev")
  })

  it("singularizes the commit count", () => {
    const v = decideVerdict({
      runningSha: "aaaaaaaa",
      originSha: "bbbbbbbb",
      comparison: { isAncestor: true, behind: 1 },
    })
    expect(v.message).toContain("1 commit behind")
    expect(v.message).not.toContain("1 commits")
  })

  it("AHEAD when running is not an ancestor of origin/main", () => {
    const v = decideVerdict({
      runningSha: "aaaaaaaa",
      originSha: "bbbbbbbb",
      comparison: { isAncestor: false, behind: 0 },
    })
    expect(v.verdict).toBe("AHEAD")
  })

  it("UNKNOWN when the running sha is unparseable", () => {
    const v = decideVerdict({
      runningSha: null,
      originSha: "e3fffce8",
      comparison: null,
    })
    expect(v.verdict).toBe("UNKNOWN")
  })

  it("UNKNOWN when origin/main is unresolvable", () => {
    const v = decideVerdict({
      runningSha: "7856b665",
      originSha: null,
      comparison: null,
    })
    expect(v.verdict).toBe("UNKNOWN")
    expect(v.message).toContain("git fetch")
  })

  it("UNKNOWN when the running commit is not in the local DB", () => {
    const v = decideVerdict({
      runningSha: "7856b665",
      originSha: "e3fffce8",
      comparison: null,
    })
    expect(v.verdict).toBe("UNKNOWN")
    expect(v.message).toContain("git fetch")
  })
})

describe("assessConfigFlags", () => {
  it("reports retention24h true when set to 24h", () => {
    const s = assessConfigFlags(
      { promptCacheRetention: "24h" },
      "/x/config.json",
    )
    expect(s.readable).toBe(true)
    expect(s.retention24h).toBe(true)
    expect(s.promptCacheRetention).toBe("24h")
  })

  it("reports NOT ready when unset", () => {
    const s = assessConfigFlags({}, "/x/config.json")
    expect(s.readable).toBe(true)
    expect(s.retention24h).toBe(false)
    expect(s.promptCacheRetention).toBeUndefined()
  })

  it("reports NOT ready for a non-24h value (in_memory)", () => {
    const s = assessConfigFlags(
      { promptCacheRetention: "in_memory" },
      "/x/config.json",
    )
    expect(s.retention24h).toBe(false)
    expect(s.promptCacheRetention).toBe("in_memory")
  })

  it("reports not readable when config is null", () => {
    const s = assessConfigFlags(null, "/x/config.json")
    expect(s.readable).toBe(false)
    expect(s.retention24h).toBe(false)
    expect(s.path).toBe("/x/config.json")
  })
})

describe("resolveConfigPath", () => {
  it("honors COPILOT_API_HOME on any platform", () => {
    expect(
      resolveConfigPath({
        platform: "darwin",
        homedir: "/home/u",
        copilotApiHome: "/custom/home",
      }),
    ).toBe("/custom/home/config.json")
  })

  it("uses ~/.local/share/maximal on macOS/Linux", () => {
    expect(resolveConfigPath({ platform: "darwin", homedir: "/home/u" })).toBe(
      "/home/u/.local/share/maximal/config.json",
    )
  })

  it(String.raw`uses %APPDATA%\maximal on win32`, () => {
    const p = resolveConfigPath({
      platform: "win32",
      homedir: String.raw`C:\Users\u`,
      appData: String.raw`C:\Users\u\AppData\Roaming`,
    })
    expect(p.replaceAll("\\", "/")).toBe(
      "C:/Users/u/AppData/Roaming/maximal/config.json",
    )
  })
})

describe("parseArgs", () => {
  it("defaults to the loopback :4141 base url", () => {
    const prev = process.env.MAXIMAL_BASE_URL
    delete process.env.MAXIMAL_BASE_URL
    try {
      expect(parseArgs([]).baseUrl).toBe("http://127.0.0.1:4141")
    } finally {
      if (prev !== undefined) process.env.MAXIMAL_BASE_URL = prev
    }
  })

  it("takes --base-url and strips a trailing slash", () => {
    expect(parseArgs(["--base-url", "http://127.0.0.1:4142/"]).baseUrl).toBe(
      "http://127.0.0.1:4142",
    )
  })
})

const baseDeps = (over: Partial<VerifyDeps>): VerifyDeps => ({
  fetchVersionHeader: () => Promise.resolve("0.4.39-dev+7856b665"),
  gitOriginSha: () => "e3fffce8",
  gitCompare: () => ({ isAncestor: true, behind: 5 }),
  readConfig: () => ({ promptCacheRetention: "24h" }),
  ...over,
})

describe("verifyBuild (injected deps, no mock.module)", () => {
  it("STALE end-to-end when the running sha is behind origin/main", async () => {
    const report = await verifyBuild("http://x", "/x/config.json", baseDeps({}))
    expect(report.proxyReachable).toBe(true)
    expect(report.runningSha).toBe("7856b665")
    expect(report.originSha).toBe("e3fffce8")
    expect(report.verdict.verdict).toBe("STALE")
    expect(report.config.retention24h).toBe(true)
  })

  it("does NOT call gitCompare when the sha already matches origin/main", async () => {
    let compareCalls = 0
    const report = await verifyBuild(
      "http://x",
      "/x/config.json",
      baseDeps({
        fetchVersionHeader: () => Promise.resolve("0.4.39-dev+e3fffce8"),
        gitCompare: () => {
          compareCalls++
          return { isAncestor: true, behind: 0 }
        },
      }),
    )
    expect(report.verdict.verdict).toBe("PASS")
    expect(compareCalls).toBe(0)
  })

  it("marks proxy unreachable when the header fetch returns null", async () => {
    const report = await verifyBuild(
      "http://x",
      "/x/config.json",
      baseDeps({ fetchVersionHeader: () => Promise.resolve(null) }),
    )
    expect(report.proxyReachable).toBe(false)
    expect(report.verdict.verdict).toBe("UNKNOWN")
  })
})
