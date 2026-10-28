/**
 * Contract for the Linux packages: how release.yml builds and gates them, how
 * deploy-pages.yml turns them into the signed apt repository, and how the
 * tray app finds the `maximal` package's binaries.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { channelForTag } from "../scripts/write-updates-manifest"

const REPO_ROOT = resolve(import.meta.dir, "..")
const read = (path: string): string =>
  readFileSync(resolve(REPO_ROOT, path), "utf8")

const RELEASE = read(".github/workflows/release.yml")
const DEPLOY = read(".github/workflows/deploy-pages.yml")
const SMOKE = read("build/linux/smoke-deb.sh")
const LINUX_CONF = JSON.parse(
  read("shell/src-tauri/tauri.linux.conf.json"),
) as {
  mainBinaryName?: string
  bundle?: {
    externalBin?: unknown
    linux?: {
      deb?: { depends?: Array<string>; files?: Record<string, string> }
    }
  }
}

/** The text of one top-level job in a workflow. */
const job = (workflow: string, name: string): string => {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  expect(start).toBeGreaterThan(-1)
  const next = workflow.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/u)
  return next === -1 ?
      workflow.slice(start)
    : workflow.slice(start, start + 1 + next)
}

/** Run a bash snippet from a workflow with GITHUB_REF_NAME set; return
 *  the value of CHANNEL. */
const channelFromSnippet = (snippet: string, tag: string): string => {
  const result = Bun.spawnSync(
    ["bash", "-c", `set -euo pipefail\n${snippet}\nprintf '%s' "$CHANNEL"`],
    { env: { ...process.env, GITHUB_REF_NAME: tag } },
  )
  expect(result.exitCode).toBe(0)
  return result.stdout.toString()
}

const TAGS = ["v0.5.0", "v0.5.0-rc.1", "v0.5.1-rc.12", "v0.4.33-beta.1"]

describe("Linux release binaries", () => {
  const binaries = job(RELEASE, "binaries")

  test("are built in the binaries matrix for both architectures", () => {
    expect(binaries).toContain(
      "- { target: bun-linux-x64,    artifact: linux-x64,    ext: tar.gz }",
    )
    expect(binaries).toContain(
      "- { target: bun-linux-arm64,  artifact: linux-arm64,  ext: tar.gz }",
    )
  })

  test("are stamped with the version and channel like every other target", () => {
    // One compile step for the whole matrix: no per-target condition.
    const compile = binaries.slice(binaries.indexOf("- name: Compile binaries"))
    const step = compile.slice(0, compile.indexOf("\n      - name:", 1))
    expect(step).not.toMatch(/\n {8}if:/u)
    expect(step).toContain('--target="$BUN_TARGET"')
    expect(step).toContain(
      '--define "__MAXIMAL_VERSION__=\\"${MAXIMAL_VERSION}\\""',
    )
    expect(step).toContain('--define "__MAXIMAL_CHANNEL__=\\"${CHANNEL}\\""')
  })

  test("follow the manifest channel (and apt suite) their tag names", () => {
    const start = binaries.indexOf('TAG="${GITHUB_REF_NAME}"')
    const end = binaries.indexOf("\n          fi\n", start)
    const snippet = binaries.slice(start, end + "\n          fi".length)
    for (const tag of TAGS) {
      expect(channelFromSnippet(snippet, tag)).toBe(channelForTag(tag))
    }
    expect(channelForTag("v0.5.0-rc.1")).toBe("rc")
  })

  test("the smoke test derives the channel the same way", () => {
    const start = SMOKE.indexOf('if [[ "$version" == *-* ]]; then')
    const end = SMOKE.indexOf("\nfi\n", start)
    const snippet = `version="\${GITHUB_REF_NAME#v}"\n${SMOKE.slice(start, end + 3)}\nCHANNEL="$channel"`
    for (const tag of TAGS) {
      expect(channelFromSnippet(snippet, tag)).toBe(channelForTag(tag))
    }
  })
})

describe("Debian packages", () => {
  const linuxDeb = job(RELEASE, "linux-deb")

  test("are built on Ubuntu 24.04 for amd64 and arm64", () => {
    expect(linuxDeb).toContain("runner: ubuntu-24.04     }")
    expect(linuxDeb).toContain("runner: ubuntu-24.04-arm }")
  })

  test("package the release binaries rather than compiling new ones", () => {
    expect(linuxDeb).toContain('TARBALL="maximal-${TAG}-${ARTIFACT}.tar.gz"')
    expect(linuxDeb).toContain("sha256sum -c")
    expect(linuxDeb).toContain("bash build/linux/build-maximal-deb.sh")
    expect(linuxDeb).not.toContain("bun build --compile")
  })

  test("build the tray app without sidecars and repack it as maximal-desktop", () => {
    expect(linuxDeb).toContain("tauri build --bundles deb")
    expect(linuxDeb).toContain(String.raw`\"externalBin\":[]`)
    expect(linuxDeb).toContain("bash build/linux/repack-desktop-deb.sh")
    expect(LINUX_CONF.mainBinaryName).toBe("maximal-desktop")
    expect(LINUX_CONF.bundle?.externalBin).toBeUndefined()
    expect(LINUX_CONF.bundle?.linux?.deb?.depends).toContain(
      "libayatana-appindicator3-1",
    )
    expect(
      LINUX_CONF.bundle?.linux?.deb?.files?.[
        "/usr/lib/maximal/desktop-installed-by-apt"
      ],
    ).toBeDefined()
  })

  test("are smoke-tested on every target distribution and architecture", () => {
    const smoke = job(RELEASE, "linux-deb-smoke")
    expect(smoke).toContain("arch: [amd64, arm64]")
    expect(smoke).toContain(
      'image: ["debian:13", "ubuntu:24.04", "ubuntu:26.04"]',
    )
    expect(smoke).toContain("bash /src/build/linux/smoke-deb.sh")
    expect(SMOKE).toContain("dpkg -L maximal-desktop")
    expect(SMOKE).toContain("--only-upgrade maximal maximal-desktop")
  })

  test("gate publication", () => {
    const publish = job(RELEASE, "publish")
    expect(publish).toContain("- linux-deb\n")
    expect(publish).toContain("- linux-deb-smoke\n")
  })
})

describe("apt repository (deploy-pages.yml)", () => {
  test("is planned from the manifest the same deploy publishes", () => {
    expect(DEPLOY).toContain("bun scripts/apt-repo-plan.ts")
    expect(DEPLOY).toContain("--manifest site/public/updates/manifest.json")
    expect(DEPLOY).toContain("bash build/linux/apt-repo.sh fetch")
    expect(DEPLOY).toContain("bash build/linux/apt-repo.sh index")
    // Built after Astro, into the deployed directory.
    expect(DEPLOY.indexOf("bun run build")).toBeLessThan(
      DEPLOY.indexOf("bun scripts/apt-repo-plan.ts"),
    )
    expect(DEPLOY).toContain("site/dist/apt")
  })

  test("only the signing step sees the signing secrets", () => {
    const secretLines = DEPLOY.split("\n").filter((line) =>
      line.includes("secrets.APT_SIGNING_KEY"),
    )
    expect(secretLines).toHaveLength(2)
    const signStep = DEPLOY.slice(
      DEPLOY.indexOf("- name: Sign the apt repository"),
      DEPLOY.indexOf("- name: Check the site size"),
    )
    for (const line of secretLines) expect(signStep).toContain(line)
    expect(signStep).toContain(
      "APT_SIGNING_KEY_FINGERPRINT: ${{ vars.APT_SIGNING_KEY_FINGERPRINT }}",
    )
    expect(signStep).toContain("site/public/apt/maximal.asc")
  })

  test("the committed public key is Maximal's apt key", () => {
    const key = read("site/public/apt/maximal.asc")
    expect(key).toStartWith("-----BEGIN PGP PUBLIC KEY BLOCK-----")
    expect(key).not.toContain("PRIVATE KEY")
  })

  test("redeploys when the manifest PR merges", () => {
    const paths = DEPLOY.slice(
      DEPLOY.indexOf("paths:"),
      DEPLOY.indexOf("workflow_dispatch:"),
    )
    expect(paths).toContain('- "site/**"')
  })
})
