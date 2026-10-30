#!/usr/bin/env bun
/** Launch the Tauri development app with an isolated, per-worktree profile. */

import path from "node:path"

import { prepareAppDev } from "./app-dev-prepare"

const repoRoot = path.resolve(import.meta.dir, "..")

async function run(
  cmd: Array<string>,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const child = Bun.spawn({
    cmd,
    cwd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) {
    throw new Error(`${path.basename(cmd[0] ?? "command")} exited ${exitCode}`)
  }
}

async function main(): Promise<void> {
  const prepared = await prepareAppDev(process.env, repoRoot)
  const bun = process.execPath

  await run([bun, "run", "app:sidecar"], repoRoot, prepared.env)
  await run(
    [
      bun,
      "run",
      "tauri",
      "dev",
      "--config",
      "src-tauri/tauri.dev.conf.json",
    ],
    path.join(repoRoot, "shell"),
    prepared.env,
  )
}

try {
  await main()
} catch (error) {
  console.error(
    `[app-dev] ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exit(1)
}
