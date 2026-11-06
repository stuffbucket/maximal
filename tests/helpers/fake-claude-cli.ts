/**
 * A stand-in `claude` executable for end-to-end tests: put first on PATH, it
 * is what Maximal's install detection finds (`detectClaudeInstalls`), which
 * turning on Claude Code in Settings requires. It only answers `--version`;
 * Maximal edits Claude Code's config files itself.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const FAKE_CLAUDE_VERSION = "2.1.0"

export interface FakeClaudeCli {
  /** The directory holding the executable (prepended to PATH). */
  binDir: string
  /** Restore PATH and remove the files. */
  dispose(): void
}

/** Write the fake and put its directory first on PATH. */
export function installFakeClaudeCli(): FakeClaudeCli {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"))
  const banner = `${FAKE_CLAUDE_VERSION} (Claude Code)`
  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(binDir, "claude.cmd"),
      `@echo off\r\necho ${banner}\r\n`,
    )
  } else {
    const executable = path.join(binDir, "claude")
    fs.writeFileSync(executable, `#!/bin/sh\necho "${banner}"\n`)
    fs.chmodSync(executable, 0o755)
  }

  const previousPath = process.env.PATH
  process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter)

  return {
    binDir,
    dispose() {
      process.env.PATH = previousPath
      fs.rmSync(binDir, { recursive: true, force: true })
    },
  }
}
