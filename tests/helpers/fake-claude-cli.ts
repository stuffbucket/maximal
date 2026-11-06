/**
 * A stand-in `claude` executable for end-to-end tests: put first on PATH, it
 * is what Maximal's own detection finds and runs (`detectClaudeInstalls`,
 * the plugin client's `claude mcp add-json` / `remove`). It answers
 * `--version` and edits `$CLAUDE_CONFIG_DIR/.claude.json` → `mcpServers` the
 * way Claude Code's user scope does, refusing to add a name that exists or
 * remove one that doesn't. Every invocation's argv is appended to a log.
 *
 * POSIX gets a `#!/bin/sh` wrapper around the running Bun; Windows only runs
 * a real `.exe` (see `defaultRunner`), so there the script is compiled.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const FAKE_CLAUDE_VERSION = "2.1.0"

export interface FakeClaudeCli {
  /** The directory holding the executable (prepended to PATH). */
  binDir: string
  /** The executable Maximal will find. */
  executable: string
  /** Every argv the CLI was run with, oldest first. */
  calls(): Array<Array<string>>
  /** Restore PATH and remove the files. */
  dispose(): void
}

function script(logFile: string): string {
  return `
const fs = require("node:fs")
const path = require("node:path")
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n")
if (args[0] === "--version") {
  console.log("${FAKE_CLAUDE_VERSION} (Claude Code)")
  process.exit(0)
}
const fail = (message) => {
  console.error(message)
  process.exit(1)
}
const [group, verb, scopeFlag, scope, name, json] = args
if (group !== "mcp" || scopeFlag !== "--scope" || scope !== "user" || !name)
  fail("fake claude: unsupported command " + args.join(" "))
const dir = process.env.CLAUDE_CONFIG_DIR
if (!dir) fail("fake claude: CLAUDE_CONFIG_DIR is not set")
const file = path.join(dir, ".claude.json")
const document = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}
const servers = { ...document.mcpServers }
if (verb === "add-json") {
  if (Object.hasOwn(servers, name))
    fail("MCP server " + name + " already exists in user config")
  servers[name] = JSON.parse(json)
} else if (verb === "remove") {
  if (!Object.hasOwn(servers, name))
    fail("No user-scoped MCP server found with name: " + name)
  delete servers[name]
} else {
  fail("fake claude: unsupported verb " + verb)
}
fs.writeFileSync(file, JSON.stringify({ ...document, mcpServers: servers }, null, 2))
console.log(verb === "remove" ? "Removed MCP server " + name : "Added MCP server " + name)
`
}

/** Write the fake and put its directory first on PATH. */
export function installFakeClaudeCli(): FakeClaudeCli {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"))
  const binDir = path.join(root, "bin")
  fs.mkdirSync(binDir)
  const logFile = path.join(root, "calls.jsonl")
  fs.writeFileSync(logFile, "")
  const source = path.join(root, "fake-claude.cjs")
  fs.writeFileSync(source, script(logFile))

  let executable: string
  if (process.platform === "win32") {
    executable = path.join(binDir, "claude.exe")
    const build = Bun.spawnSync([
      process.execPath,
      "build",
      "--compile",
      source,
      "--outfile",
      executable,
    ])
    if (build.exitCode !== 0) {
      throw new Error(
        `could not compile the fake claude: ${build.stderr.toString()}`,
      )
    }
  } else {
    executable = path.join(binDir, "claude")
    fs.writeFileSync(
      executable,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(source)} "$@"\n`,
    )
    fs.chmodSync(executable, 0o755)
  }

  const previousPath = process.env.PATH
  process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter)

  return {
    binDir,
    executable,
    calls: () =>
      fs
        .readFileSync(logFile, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Array<string>),
    dispose() {
      process.env.PATH = previousPath
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}
