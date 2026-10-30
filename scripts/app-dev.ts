#!/usr/bin/env bun
/** Launch Tauri with this worktree's stable, isolated development profile. */

import path from "node:path"

import {
  prepareAppDev,
  stopPriorDevSession,
} from "./app-dev-prepare"

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
  const prepared = prepareAppDev(process.env, repoRoot)
  const bun = process.execPath

  console.log(`[app-dev] profile: ${prepared.worktreeId}`)
  console.log(`[app-dev] data: ${prepared.home}`)

  if (await stopPriorDevSession(prepared.home, prepared.identifier)) {
    console.log("[app-dev] prior session stopped")
  }

  await run([bun, "run", "app:sidecar"], repoRoot, prepared.env)
  const forwardedArgs = process.argv.slice(2)
  if (forwardedArgs[0] === "--") forwardedArgs.shift()
  await run(
    [
      bun,
      "run",
      "tauri",
      "dev",
      "--config",
      prepared.configPath,
      ...forwardedArgs,
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
