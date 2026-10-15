#!/usr/bin/env bun
/**
 * Run the Tauri shell's Rust unit tests (`cargo test --lib`) without
 * building the sidecar binaries first.
 *
 * Compiling the shell needs two things a test doesn't use: the built UI
 * (`frontendDist`, from `bun run build:ui`, which is fast) and the
 * `externalBin` sidecars (slow to build). We build the UI and drop
 * `externalBin` through Tauri's `TAURI_CONFIG` override rather than
 * staging placeholder binaries, which `build-sidecar.ts` could mistake for
 * up-to-date builds.
 *
 * Rust is pinned in mise.toml; run `mise install` once.
 *
 * Usage: bun run shell:test [-- <cargo test args>]
 */
import { resolve } from "node:path"

const REPO = resolve(import.meta.dir, "..")

const run = (cmd: Array<string>, env?: Record<string, string>): number =>
  Bun.spawnSync(cmd, {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ["inherit", "inherit", "inherit"],
  }).exitCode

const built = run(["bun", "run", "build:ui"])
if (built !== 0) process.exit(built)

process.exit(
  run(
    [
      "mise",
      "exec",
      "--",
      "cargo",
      "test",
      "--manifest-path",
      "shell/src-tauri/Cargo.toml",
      "--lib",
      ...process.argv.slice(2),
    ],
    { TAURI_CONFIG: JSON.stringify({ bundle: { externalBin: [] } }) },
  ),
)
