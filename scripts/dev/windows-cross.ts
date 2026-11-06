#!/usr/bin/env bun

import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { delimiter, join, resolve } from "node:path"

const REPO = resolve(import.meta.dir, "../..")
const TOOL_DIR = join(REPO, "tools/windows-cross")
const CACHE_DIR = join(REPO, ".cargo-xwin")
const OUTPUT_DIR = join(REPO, "dist-windows")
const TARGET = "x86_64-pc-windows-msvc"
const MANIFEST = join(REPO, "shell/src-tauri/Cargo.toml")
const TAURI_CONFIG = JSON.stringify({
  productName: "Maximal Windows Dev",
  identifier: "co.stuffbucket.maximal.dev.windows-cross",
})

const action = process.argv[2]

switch (action) {
  case "setup":
    setup()
    break
  case "check":
    ensureReady()
    prepareUi()
    buildWindowsSidecars()
    runXwin("check")
    break
  case "build":
    ensureReady()
    buildVmPayload()
    break
  default:
    fail("usage: windows-cross.ts <setup|check|build>")
}

function setup(): void {
  if (process.platform !== "darwin") {
    fail("the local cargo-xwin setup is intended for macOS development hosts")
  }

  reportEditorAndSdkState()
  ensureHomebrewLlvm()
  run("mise", ["trust", join(TOOL_DIR, "mise.toml")])
  run("mise", ["-C", TOOL_DIR, "install"])
  runMise(["rustup", "target", "add", TARGET])
  run(process.execPath, ["run", "mcp-broker:install"], undefined, REPO)

  mkdirSync(windowsCacheDir(), { recursive: true })
  console.error(
    "[windows-cross] caching the Microsoft Windows SDK/CRT; using it accepts Microsoft's license terms",
  )
  runMise(["cargo", "xwin", "cache", "xwin"], crossEnvironment())
  console.error("[windows-cross] ready")
}

function ensureReady(): void {
  const llvmBin = homebrewLlvmBin()
  if (!llvmBin || !existsSync(join(llvmBin, "clang-cl"))) {
    fail("Homebrew LLVM is missing; run `bun run app:windows:setup`")
  }

  const result = runMise(
    ["cargo", "xwin", "--version"],
    crossEnvironment(),
    false,
  )
  if (result !== 0) {
    fail("cargo-xwin is missing; run `bun run app:windows:setup`")
  }
}

function prepareUi(): void {
  run(process.execPath, ["run", "build:ui"], undefined, REPO)
  run(process.execPath, ["run", "scripts/gen-ui-embed.ts"], undefined, REPO)
}

function runXwin(command: "build" | "check"): void {
  runMise(
    [
      "cargo",
      "xwin",
      command,
      ...(command === "build" ? ["--release"] : []),
      "--manifest-path",
      MANIFEST,
      "--target",
      TARGET,
    ],
    crossEnvironment(),
  )
}

function buildWindowsSidecars(): void {
  run(
    process.execPath,
    ["run", "scripts/build-sidecar.ts", "--force", `--target-triple=${TARGET}`],
    undefined,
    REPO,
  )
}

function buildVmPayload(): void {
  prepareUi()
  buildWindowsSidecars()
  runXwin("build")

  const shellExe = join(
    REPO,
    `shell/src-tauri/target/${TARGET}/release/maximal-shell.exe`,
  )
  const binaries = join(REPO, "shell/src-tauri/binaries")
  const proxyExe = join(binaries, `maximal-${TARGET}.exe`)
  const brokerExe = join(binaries, `maximal-mcp-broker-${TARGET}.exe`)
  for (const artifact of [shellExe, proxyExe, brokerExe]) {
    if (!existsSync(artifact))
      fail(`expected build artifact is missing: ${artifact}`)
  }

  rmSync(OUTPUT_DIR, { recursive: true, force: true })
  mkdirSync(OUTPUT_DIR, { recursive: true })
  copyFileSync(shellExe, join(OUTPUT_DIR, "maximal-shell.exe"))
  copyFileSync(proxyExe, join(OUTPUT_DIR, "maximal.exe"))
  copyFileSync(brokerExe, join(OUTPUT_DIR, "maximal-mcp-broker.exe"))
  writeFileSync(
    join(OUTPUT_DIR, "README.txt"),
    [
      "Maximal Windows development payload",
      "",
      "Keep all three .exe files together and run maximal-shell.exe.",
      "This is an installer-free developer build for local VM testing only.",
      "",
    ].join("\r\n"),
  )
  console.error(`[windows-cross] VM payload: ${OUTPUT_DIR}`)
}

function crossEnvironment(): NodeJS.ProcessEnv {
  const llvmBin = homebrewLlvmBin()
  return {
    ...process.env,
    PATH: llvmBin
      ? `${llvmBin}${delimiter}${process.env.PATH ?? ""}`
      : process.env.PATH,
    XWIN_ARCH: "x86_64",
    XWIN_CACHE_DIR: windowsCacheDir(),
    TAURI_CONFIG,
  }
}

function windowsCacheDir(): string {
  return resolve(process.env.XWIN_CACHE_DIR ?? CACHE_DIR)
}

function ensureHomebrewLlvm(): void {
  const llvmBin = homebrewLlvmBin()
  if (llvmBin && existsSync(join(llvmBin, "clang-cl"))) {
    console.error(`[windows-cross] using LLVM from ${llvmBin}`)
    return
  }
  if (!commandSucceeds("brew", ["--version"])) {
    fail("Homebrew is required to install LLVM on macOS")
  }
  run("brew", ["install", "llvm"])
}

function homebrewLlvmBin(): string | undefined {
  const result = spawnSync("brew", ["--prefix", "llvm"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.status !== 0) return undefined
  const prefix = result.stdout.trim()
  return prefix ? join(prefix, "bin") : undefined
}

function reportEditorAndSdkState(): void {
  const vscodePaths = [
    "/Applications/Visual Studio Code.app",
    join(process.env.HOME ?? "", "Applications/Visual Studio Code.app"),
  ]
  const vscode = vscodePaths.find((candidate) => existsSync(candidate))
  const vscodeCli = commandSucceeds("code", ["--version"])
  if (vscode || vscodeCli) {
    const location = vscode ? ` at ${vscode}` : " on PATH"
    console.error(
      `[windows-cross] VS Code found${location}; it does not include the Windows SDK`,
    )
  } else {
    console.error("[windows-cross] VS Code not found (not required)")
  }

  const cacheDir = windowsCacheDir()
  if (process.env.XWIN_CACHE_DIR) {
    console.error(`[windows-cross] reusing XWIN_CACHE_DIR=${cacheDir}`)
  } else {
    console.error(
      `[windows-cross] Windows SDK/CRT will be cached under ${cacheDir}`,
    )
  }
}

function runMise(
  args: Array<string>,
  env = process.env,
  exitOnError = true,
): number {
  return run(
    "mise",
    ["-C", TOOL_DIR, "exec", "--", ...args],
    env,
    REPO,
    exitOnError,
  )
}

function commandSucceeds(command: string, args: Array<string>): boolean {
  return spawnSync(command, args, { stdio: "ignore" }).status === 0
}

function run(
  command: string,
  args: Array<string>,
  env = process.env,
  cwd = REPO,
  exitOnError = true,
): number {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" })
  const status = result.status ?? 1
  if (status !== 0 && exitOnError) process.exit(status)
  return status
}

function fail(message: string): never {
  console.error(`[windows-cross] ${message}`)
  process.exit(1)
}
