#!/usr/bin/env bun
/**
 * Build a polished `.dmg` for a published release. macOS-only;
 * intended to run on a developer's Mac after CI has produced the
 * per-arch `.tar.gz` for the tag.
 *
 * The CI release pipeline ships `.app.zip` (drag-to-Applications
 * after Finder extract) on every tag, since macOS runners aren't
 * available in the public-repo policy. This script restores the
 * mounted-DMG view as a manual post-tag step.
 *
 * Steps:
 *   1. `gh release download <tag> --pattern '*-darwin-arm64.tar.gz*'`
 *   2. Verify the SHA-256 against the sidecar file.
 *   3. Assemble `maximal.app` from build/macos/app-template + the
 *      unpacked binary (same logic the `macos-app-zip` CI job runs).
 *   4. `npx create-dmg ...` to build the polished DMG.
 *   5. Sidecar `.sha256`. Optional `--upload` attaches both to the
 *      same release.
 *
 * Apple Silicon only — Intel macOS is not a supported target.
 *
 * Usage:
 *
 *   bun run package-dmg --tag v0.1.0
 *   bun run package-dmg --tag v0.1.0 --upload
 *   bun run package-dmg --tag v0.1.0 --repo myorg/myrepo
 *
 * Outputs land in `dist-release/`.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

interface Args {
  tag: string
  repo: string | undefined
  upload: boolean
  keepWork: boolean
}

function parseArgs(argv: Array<string>): Args {
  let tag: string | undefined
  let repo: string | undefined
  let upload = false
  let keepWork = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--tag") tag = argv[++i]
    else if (a === "--repo") repo = argv[++i]
    else if (a === "--upload") upload = true
    else if (a === "--keep-work") keepWork = true
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: bun run package-dmg [--tag v<x.y.z>] [--repo owner/name] [--upload] [--keep-work]\n\n" +
          "  --tag       defaults to `git describe --tags --abbrev=0`\n" +
          "  --repo      defaults to the GitHub remote of `origin`\n" +
          "  --upload    attach the .dmg + .sha256 to the GitHub release\n" +
          "  --keep-work leave the staging dirs in dist-build/ for inspection",
      )
      process.exit(0)
    }
  }
  if (!tag) {
    // Default to the most recent annotated/lightweight tag in the
    // working tree. Helpful when a release engineer just tagged + pushed
    // and wants to immediately produce the DMG without retyping the tag.
    try {
      tag = runCapture("git", ["describe", "--tags", "--abbrev=0"])
    } catch {
      throw new Error(
        "--tag not provided and no tags found in this checkout (run `git fetch --tags` first, or pass --tag v<x.y.z>)",
      )
    }
  }
  return { tag, repo, upload, keepWork }
}

function run(
  cmd: string,
  cmdArgs: Array<string>,
  opts: { cwd?: string } = {},
): void {
  const r = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    cwd: opts.cwd,
  })
  if (r.status !== 0) {
    throw new Error(`${cmd} ${cmdArgs.join(" ")} → exit ${r.status}`)
  }
}

function runCapture(
  cmd: string,
  cmdArgs: Array<string>,
  opts: { cwd?: string } = {},
): string {
  const r = spawnSync(cmd, cmdArgs, { encoding: "utf8", cwd: opts.cwd })
  if (r.status !== 0) {
    throw new Error(`${cmd} ${cmdArgs.join(" ")} → exit ${r.status}: ${r.stderr}`)
  }
  return r.stdout.trim()
}

function detectRepo(): string {
  // Accepts:
  //   https://github.com/<owner>/<name>(.git)
  //   git@github.com:<owner>/<name>(.git)
  //   git@github.com-<alias>:<owner>/<name>(.git)  ← multi-account SSH aliases
  const url = runCapture("git", ["remote", "get-url", "origin"])
  const m = url.match(/github\.com(?:-[\w.-]+)?[:/]([^/]+\/[^/.]+)/u)
  if (!m) {
    throw new Error(`could not parse GitHub repo from origin: ${url}`)
  }
  return m[1]
}

function ensureMacOS(): void {
  if (process.platform !== "darwin") {
    throw new Error(
      "package-dmg.ts must run on macOS (create-dmg uses hdiutil).",
    )
  }
}

function rmrf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true })
}

function assembleApp(
  binarySrc: string,
  templateDir: string,
  outApp: string,
  version: string,
): void {
  rmrf(outApp)
  // cp -R preserves the template layout: Contents/Info.plist,
  // Contents/MacOS/first-launch, Contents/Resources/...
  run("cp", ["-R", templateDir, outApp])

  // Substitute __VERSION__ in Info.plist (BSD sed: -i ''; this script
  // is macOS-only so we don't need GNU compatibility).
  const plist = path.join(outApp, "Contents/Info.plist")
  run("sed", ["-i", "", "-e", `s/__VERSION__/${version}/g`, plist])

  // Drop the placeholder, copy the real binary.
  rmrf(path.join(outApp, "Contents/MacOS/maximal.placeholder"))
  fs.copyFileSync(binarySrc, path.join(outApp, "Contents/MacOS/maximal"))
  fs.chmodSync(path.join(outApp, "Contents/MacOS/maximal"), 0o755)

  // Real icon if a designer dropped one alongside the placeholder.
  rmrf(path.join(outApp, "Contents/Resources/AppIcon.icns.placeholder"))
  const icon = path.join(templateDir, "Contents/Resources/AppIcon.icns")
  if (fs.existsSync(icon)) {
    fs.copyFileSync(icon, path.join(outApp, "Contents/Resources/AppIcon.icns"))
  }
}

async function main(): Promise<number> {
  ensureMacOS()
  const args = parseArgs(process.argv.slice(2))
  const repo = args.repo ?? detectRepo()
  const version = args.tag.replace(/^v/, "")
  const arch = "arm64"
  const tarball = `maximal-${args.tag}-darwin-${arch}.tar.gz`
  const sha256File = `${tarball}.sha256`

  const work = "dist-build/dmg"
  const release = "dist-release"
  rmrf(work)
  fs.mkdirSync(work, { recursive: true })
  fs.mkdirSync(release, { recursive: true })

  console.log(`==> Downloading ${tarball} from ${repo} release ${args.tag}`)
  run("gh", [
    "release",
    "download",
    args.tag,
    "--repo",
    repo,
    "--pattern",
    tarball,
    "--pattern",
    sha256File,
    "--dir",
    work,
  ])

  console.log("==> Verifying SHA-256")
  run("shasum", ["-a", "256", "-c", sha256File], { cwd: work })

  console.log("==> Unpacking")
  fs.mkdirSync(path.join(work, "unpacked"), { recursive: true })
  run("tar", ["-xzf", tarball, "-C", "unpacked"], { cwd: work })

  // Locate the binary inside the unpacked tree (Stream A's tarball
  // ships it at the root, but tolerate one level of nesting).
  const unpackedRoot = path.join(work, "unpacked")
  let binarySrc: string | undefined
  for (const entry of fs.readdirSync(unpackedRoot, { withFileTypes: true })) {
    const candidate = path.join(unpackedRoot, entry.name)
    if (entry.isFile() && entry.name === "maximal") {
      binarySrc = candidate
      break
    }
    if (entry.isDirectory()) {
      const inner = path.join(candidate, "maximal")
      if (fs.existsSync(inner)) {
        binarySrc = inner
        break
      }
    }
  }
  if (!binarySrc) {
    throw new Error(`maximal binary not found in ${unpackedRoot}`)
  }

  console.log("==> Assembling maximal.app")
  const appOut = path.join(work, "maximal.app")
  assembleApp(binarySrc, "build/macos/app-template", appOut, version)

  console.log("==> Building DMG via create-dmg")
  // Use the real DMG background if a designer has dropped it in;
  // otherwise create-dmg's default template is acceptable for v1.
  const bg = "build/macos/dmg-bg.png"
  const createDmgArgs = ["--yes", "create-dmg", appOut, release]
  if (fs.existsSync(bg)) {
    createDmgArgs.push("--background", bg)
  }
  // `--identity=` (empty) tells create-dmg not to attempt code-signing
  // — A4 is deferred. The resulting DMG will trigger Gatekeeper on
  // first open; users follow the right-click → Open instructions on
  // the Pages site.
  createDmgArgs.push("--identity=")
  createDmgArgs.push(`--dmg-title=maximal ${version}`)
  // create-dmg exits non-zero if codesign isn't set up but still
  // produces the .dmg. Tolerate non-zero by checking for output.
  const r = spawnSync("npx", createDmgArgs, { stdio: "inherit" })
  if (r.status !== 0) {
    console.warn(
      `create-dmg exited ${r.status} (likely the codesign warning). Verifying .dmg was produced anyway.`,
    )
  }

  // create-dmg names the file `maximal ${version}.dmg` (with a
  // space). Rename to our canonical artifact name.
  const desired = `maximal-${args.tag}-darwin-${arch}.dmg`
  const produced = fs
    .readdirSync(release)
    .find((f) => f.endsWith(".dmg") && f !== desired)
  if (!produced) {
    if (!fs.existsSync(path.join(release, desired))) {
      throw new Error("create-dmg did not produce a .dmg")
    }
  } else {
    fs.renameSync(path.join(release, produced), path.join(release, desired))
  }

  // Belt-and-suspenders: verify the renamed/desired .dmg actually exists
  // before computing the hash. If create-dmg failed harder than the
  // codesign warning suggested, surface that explicitly.
  const dmgPath = path.join(release, desired)
  if (!fs.existsSync(dmgPath)) {
    throw new Error(
      `expected DMG at ${dmgPath} but no file is present. ` +
        `create-dmg exited ${r.status} earlier — it likely produced nothing usable. ` +
        `Re-run with --keep-work and inspect dist-build/dmg/.`,
    )
  }

  console.log("==> Generating SHA-256")
  // shasum needs to run in `release/` so its output records the bare
  // filename (matches how `shasum -c` later expects it).
  const sha = runCapture("shasum", ["-a", "256", desired], { cwd: release })
  fs.writeFileSync(path.join(release, `${desired}.sha256`), sha + "\n")
  console.log(sha)

  if (args.upload) {
    console.log(`==> Uploading to release ${args.tag}`)
    run("gh", [
      "release",
      "upload",
      args.tag,
      "--repo",
      repo,
      "--clobber",
      path.join(release, desired),
      path.join(release, `${desired}.sha256`),
    ])
  }

  if (!args.keepWork) {
    rmrf(work)
  }

  console.log(`\n✓ ${path.join(release, desired)}`)
  if (!args.upload) {
    console.log(
      `  (run with --upload to attach this .dmg + .sha256 to the release)`,
    )
  }
  return 0
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(`package-dmg: ${err.message}`)
    process.exit(1)
  },
)
