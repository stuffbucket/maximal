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
const APT_REPO = read("build/linux/apt-repo.sh")
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
  const build = job(DEPLOY, "build")
  const sign = job(DEPLOY, "sign-apt")
  const deploy = job(DEPLOY, "deploy")

  test("build only plans, from the manifest the same deploy publishes", () => {
    expect(build).toContain("bun scripts/apt-repo-plan.ts")
    expect(build).toContain("--manifest site/public/updates/manifest.json")
    expect(build).toContain("apt: ${{ steps.apt.outputs.build }}")
    expect(build).toContain("suites: ${{ steps.apt.outputs.suites }}")
    // Nothing build makes (it runs project dependencies) is signed.
    expect(build).not.toContain("apt-repo.sh")
    expect(build).not.toContain("apt-ftparchive")
    expect(build).not.toContain("name: apt")
    expect(build).not.toContain("secrets.")
  })

  test("sign-apt fetches, indexes and signs, in that order, in the github-pages environment", () => {
    expect(sign).toContain("environment: github-pages")
    expect(sign).toContain("if: needs.build.outputs.apt == 'true'")
    const fetch = sign.indexOf(
      "bash build/linux/apt-repo.sh fetch apt site/public/updates/manifest.json",
    )
    const index = sign.indexOf("bash build/linux/apt-repo.sh index apt")
    const signing = sign.indexOf(
      "bash build/linux/apt-repo.sh sign apt site/public/apt/maximal.asc",
    )
    expect(fetch).toBeGreaterThan(-1)
    expect(index).toBeGreaterThan(fetch)
    expect(signing).toBeGreaterThan(index)
    // The whole signed tree, pool included, is one artifact.
    expect(sign).toContain("name: apt\n          path: apt\n")
  })

  test("only the sign step sees the signing secrets", () => {
    const secretLines = DEPLOY.split("\n").filter((line) =>
      line.includes("secrets."),
    )
    expect(secretLines).toHaveLength(2)
    const signStep = sign.slice(
      sign.indexOf("- name: Sign the apt repository"),
      sign.indexOf("- name: Upload the signed apt repository"),
    )
    for (const line of secretLines) expect(signStep).toContain(line)
    expect(signStep).toContain(
      "APT_SIGNING_KEY_FINGERPRINT: ${{ vars.APT_SIGNING_KEY_FINGERPRINT }}",
    )
    expect(deploy).not.toContain("secrets.")
  })

  test("sign-apt checks out only the script, key and manifest, and runs no project code", () => {
    expect(sign).toContain("persist-credentials: false")
    expect(sign).toContain(
      "sparse-checkout: |\n            build/linux/apt-repo.sh\n            site/public/apt/maximal.asc\n            site/public/updates/manifest.json\n",
    )
    expect(sign).toContain("sparse-checkout-cone-mode: false")
    for (const forbidden of [
      "bun ",
      "npm ",
      "pnpm ",
      "setup-",
      "mise",
      "download-artifact",
    ]) {
      expect(sign).not.toContain(forbidden)
    }
    // apt-utils only from Ubuntu's archive, only if the image lacks it.
    expect(sign).toContain("command -v apt-ftparchive >/dev/null || {")
    expect(sign).toContain(
      "sudo apt-get install -y --no-install-recommends apt-utils",
    )
  })

  test("fetch only builds the releases the manifest names, from checked assets", () => {
    expect(APT_REPO).toContain(
      'jq -r --arg s "$suite" \'.channels[$s].tag // ""\' "$manifest"',
    )
    expect(APT_REPO).toContain('sha256sum -c --strict "$deb.sha256"')
  })

  test("deploy publishes /apt only from sign-apt and the committed key, verified", () => {
    expect(deploy).toContain("needs: [build, sign-apt]")
    expect(deploy).toContain(
      "needs.sign-apt.result == 'success' || needs.sign-apt.result == 'skipped'",
    )
    expect(deploy).toContain("needs.build.result == 'success'")
    expect(deploy).toContain("persist-credentials: false")
    expect(deploy).toContain("rm -rf site/dist/apt")
    expect(deploy).toContain(
      "cp src/site/public/apt/maximal.asc site/dist/apt/maximal.asc",
    )
    expect(deploy).toContain("name: apt\n          path: site/dist/apt\n")
    expect(deploy).toContain(
      "bash src/build/linux/apt-repo.sh verify site/dist/apt src/site/public/apt/maximal.asc",
    )
    expect(deploy.indexOf("apt-repo.sh verify")).toBeLessThan(
      deploy.indexOf("uses: actions/upload-pages-artifact@"),
    )
    // verify: signed by the published key, and every Filename in the pool.
    expect(APT_REPO).toContain("not deploying an unsigned apt repository")
    expect(APT_REPO).toContain("which isn't in the pool")
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

  test("indexes are served by hash", () => {
    expect(APT_REPO).toContain("-o APT::FTPArchive::DoByHash=true")
    expect(APT_REPO).toContain("grep -qx 'Acquire-By-Hash: yes'")
  })
})

describe("packaged proxy", () => {
  test("requires the glibc it was built against", () => {
    expect(read("build/linux/build-maximal-deb.sh")).toContain(
      "Depends: libc6 (>= 2.39)",
    )
  })

  test("the user service stops retrying and has no system-only ordering", () => {
    const unit = read("build/linux/maximal.service")
    const unitSection = unit.slice(0, unit.indexOf("[Service]"))
    expect(unitSection).toContain("StartLimitIntervalSec=60")
    expect(unitSection).toContain("StartLimitBurst=5")
    expect(unit).not.toContain("network-online.target")
    expect(unit).toContain("Environment=HOST=127.0.0.1")
  })

  test("the tray app's proxy listens on loopback on Linux only", () => {
    const shell = read("shell/src-tauri/src/lib.rs")
    expect(shell).toMatch(
      /if cfg!\(target_os = "linux"\) \{\s+&\[\("HOST", "127\.0\.0\.1"\)\]\s+\} else \{\s+&\[\]/u,
    )
    const spawn = shell.slice(shell.indexOf("fn spawn_sidecar("))
    expect(spawn.slice(0, spawn.indexOf(".spawn()"))).toContain(
      "for (key, value) in sidecar_platform_env() {",
    )
  })
})
