import { describe, expect, test } from "bun:test"

import shardHosts from "../scripts/lockfile-shard-hosts.cjs"
import { stripShardHosts } from "../scripts/strip-lockfile-hosts"

const { dropShardHostUrls, lockfileHooks } = shardHosts as {
  dropShardHostUrls: (lockfile: unknown) => {
    dropped: number
    inspected: number
  }
  lockfileHooks: () => {
    hooks: { afterAllResolved: (lockfile: unknown) => unknown }
  }
}

const SHARD =
  "https://ms-feed-17.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/zod/-/zod-4.1.11.tgz"
const PINNED =
  "https://github.com/acme/thing/releases/download/v1/thing-1.0.0.tgz"

describe("stripShardHosts (lockfile text)", () => {
  test("drops shard-host tarball URLs and keeps the integrity", () => {
    const text = [
      "packages:",
      "",
      "  zod@4.1.11:",
      `    resolution: {integrity: sha1-abc=, tarball: ${SHARD}}`,
      "",
    ].join("\n")
    const result = stripShardHosts(text)
    expect(result.stripped).toBe(1)
    expect(result.text).toContain("    resolution: {integrity: sha1-abc=}")
    expect(result.text).not.toContain("ms-feed")
  })

  test("leaves other tarball URLs and non-resolution lines alone", () => {
    const text = [
      `    resolution: {integrity: sha1-abc=, tarball: ${PINNED}}`,
      `# see ${SHARD}`,
    ].join("\n")
    expect(stripShardHosts(text)).toEqual({ text, stripped: 0 })
  })
})

describe("dropShardHostUrls (pnpmfile hook)", () => {
  test("removes shard hosts from the in-memory lockfile before it's written", () => {
    type Entry = { resolution: { integrity: string; tarball?: string } }
    const lockfile: { packages: Record<string, Entry> } = {
      packages: {
        "zod@4.1.11": {
          resolution: { integrity: "sha1-abc=", tarball: SHARD },
        },
        "thing@1.0.0": {
          resolution: { integrity: "sha1-def=", tarball: PINNED },
        },
        "plain@1.0.0": { resolution: { integrity: "sha1-ghi=" } },
      },
    }
    const written = lockfileHooks().hooks.afterAllResolved(lockfile)
    expect(written).toBe(lockfile)
    expect(lockfile.packages["zod@4.1.11"].resolution).toEqual({
      integrity: "sha1-abc=",
    })
    expect(lockfile.packages["thing@1.0.0"].resolution.tarball).toBe(PINNED)
  })

  test("reports a lockfile without a packages map instead of throwing", () => {
    expect(dropShardHostUrls({ packages: null })).toEqual({
      dropped: 0,
      inspected: 0,
    })
    expect(dropShardHostUrls({})).toEqual({ dropped: 0, inspected: 0 })
  })
})
