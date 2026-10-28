/**
 * The apt repository is built from exactly the releases the updates manifest
 * names (scripts/apt-repo-plan.ts), so apt never lags what the apps announce.
 */

import { describe, expect, test } from "bun:test"

import { expectedDebs, planAptRepo } from "../scripts/apt-repo-plan"

const debs = (version: string): Array<string> => [
  `maximal_${version}_amd64.deb`,
  `maximal_${version}_arm64.deb`,
  `maximal-desktop_${version}_amd64.deb`,
  `maximal-desktop_${version}_arm64.deb`,
]

const linuxDownloads = (version: string): Record<string, { name: string }> => ({
  "linux-amd64-deb": { name: `maximal_${version}_amd64.deb` },
  "linux-arm64-deb": { name: `maximal_${version}_arm64.deb` },
  "linux-amd64-desktop-deb": { name: `maximal-desktop_${version}_amd64.deb` },
  "linux-arm64-desktop-deb": { name: `maximal-desktop_${version}_arm64.deb` },
})

const manifest = (channels: Record<string, unknown>): unknown => ({
  schema: 2,
  generated: "2026-10-27T00:00:00.000Z",
  channels,
})

describe("expectedDebs", () => {
  test("names both packages for both architectures, at the tag's version", () => {
    expect(expectedDebs("v0.5.0-rc.2")).toEqual(debs("0.5.0-rc.2"))
  })

  test("names nothing for something that isn't a release tag", () => {
    expect(expectedDebs("main")).toEqual([])
  })
})

describe("planAptRepo", () => {
  test("builds each suite from the tag its channel names", () => {
    const plan = planAptRepo(
      manifest({
        stable: { tag: "v0.5.0", downloads: linuxDownloads("0.5.0") },
        rc: { tag: "v0.5.1-rc.1", downloads: linuxDownloads("0.5.1-rc.1") },
        beta: { tag: "v0.4.0-beta.1" },
      }),
      {
        "v0.5.0": [...debs("0.5.0"), "SHA256SUMS"],
        "v0.5.1-rc.1": debs("0.5.1-rc.1"),
        // A newer release the manifest doesn't name yet is not used.
        "v0.5.1": debs("0.5.1"),
      },
    )

    expect(plan.errors).toEqual([])
    expect(plan.suites).toEqual([
      { suite: "stable", tag: "v0.5.0", debs: debs("0.5.0") },
      { suite: "rc", tag: "v0.5.1-rc.1", debs: debs("0.5.1-rc.1") },
    ])
  })

  test("fails when the manifest lists Linux packages the release lacks", () => {
    const plan = planAptRepo(
      manifest({
        stable: { tag: "v0.5.0", downloads: linuxDownloads("0.5.0") },
      }),
      { "v0.5.0": ["maximal-v0.5.0-darwin-arm64.dmg"] },
    )

    expect(plan.suites).toEqual([])
    expect(plan.errors).toEqual([
      "The manifest lists Linux packages for v0.5.0 (stable), but the release has none.",
    ])
  })

  test("skips, with a notice, a release that predates the Linux packages", () => {
    const plan = planAptRepo(
      manifest({
        stable: {
          tag: "v0.4.48",
          downloads: { "macos-arm64-dmg": { name: "x.dmg" } },
        },
        rc: { tag: "v0.5.0-rc.1", downloads: linuxDownloads("0.5.0-rc.1") },
      }),
      {
        "v0.4.48": ["maximal-v0.4.48-darwin-arm64.dmg"],
        "v0.5.0-rc.1": debs("0.5.0-rc.1"),
      },
    )

    expect(plan.errors).toEqual([])
    expect(plan.notices).toEqual([
      "v0.4.48 predates the Linux packages; skipping the stable suite.",
    ])
    expect(plan.suites.map((s) => s.suite)).toEqual(["rc"])
  })

  test("skips a channel the manifest doesn't have", () => {
    const plan = planAptRepo(
      manifest({
        stable: { tag: "v0.5.0", downloads: linuxDownloads("0.5.0") },
      }),
      { "v0.5.0": debs("0.5.0") },
    )

    expect(plan.errors).toEqual([])
    expect(plan.notices).toEqual([
      "No rc release in the manifest; skipping the rc suite.",
    ])
  })

  test("fails on a release with only some of its packages", () => {
    const plan = planAptRepo(manifest({ stable: { tag: "v0.5.0" } }), {
      "v0.5.0": debs("0.5.0").slice(0, 3),
    })

    expect(plan.errors).toEqual([
      "v0.5.0 (stable) is missing maximal-desktop_0.5.0_arm64.deb.",
    ])
  })

  test("fails when the manifest names a package of another version", () => {
    const plan = planAptRepo(
      manifest({
        stable: { tag: "v0.5.0", downloads: linuxDownloads("0.4.9") },
      }),
      { "v0.5.0": debs("0.5.0") },
    )

    expect(plan.errors[0]).toStartWith("The manifest's stable channel lists ")
    expect(plan.suites).toEqual([])
  })

  test("fails when a release can't be read or the manifest is malformed", () => {
    expect(
      planAptRepo(manifest({ stable: { tag: "v0.5.0" } }), {}).errors,
    ).toEqual(["Couldn't read the assets of v0.5.0."])
    expect(planAptRepo({ channels: "nope" }, {}).errors).toEqual([
      "The updates manifest isn't readable.",
    ])
  })
})
