/**
 * Resolve the running proxy's source revision so /_debug/state and
 * `copilot-api debug` can answer "is the deployed binary on the
 * commit I expect?" without spawning a subprocess.
 *
 * Reads `.git/HEAD` directly — if it's a symbolic ref, follows it to
 * `.git/refs/heads/<branch>`; if detached, the file already contains
 * the SHA. Falls back to packed-refs when the loose ref is absent.
 *
 * Returns `{ sha: undefined, branch: undefined }` on any I/O or parse
 * failure (e.g., binary deployed without `.git`). Callers should
 * surface "unknown" rather than crash.
 *
 * The result is cached at module init; `.git` doesn't change at
 * runtime within a single proxy lifetime.
 */

import fs from "node:fs"
import path from "node:path"

import { PATHS } from "./paths"

export interface GitVersion {
  sha: string | undefined
  branch: string | undefined
}

const SHA_RE = /^[0-9a-f]{40}$/u

interface GitDirs {
  /** The directory containing this worktree's HEAD/index. */
  worktree: string
  /** The shared/common git directory holding refs/heads, packed-refs.
   *  Equals `worktree` outside of `git worktree`-managed checkouts. */
  common: string
}

function resolveGitFile(candidate: string): GitDirs | undefined {
  let stat: fs.Stats
  try {
    stat = fs.statSync(candidate)
  } catch {
    return undefined
  }
  if (stat.isDirectory()) {
    return { worktree: candidate, common: candidate }
  }
  // Worktree pointer file: `gitdir: <abs-or-rel path>`
  let pointer: string
  try {
    pointer = fs.readFileSync(candidate, "utf8").trim()
  } catch {
    return undefined
  }
  const match = pointer.match(/^gitdir: (\S.*)$/u)
  if (!match) return undefined
  const worktreeDir =
    path.isAbsolute(match[1]) ?
      match[1]
    : path.resolve(path.dirname(candidate), match[1])
  let commonDir = worktreeDir
  try {
    const rel = fs
      .readFileSync(path.join(worktreeDir, "commondir"), "utf8")
      .trim()
    commonDir = path.isAbsolute(rel) ? rel : path.resolve(worktreeDir, rel)
  } catch {
    // No commondir → this is the main git directory.
  }
  return { worktree: worktreeDir, common: commonDir }
}

function findGitDirs(): GitDirs | undefined {
  // Walk up from the proxy install dir / cwd. The published binary
  // may not have .git; the dev tree always does.
  const starts = [
    process.cwd(),
    PATHS.APP_DIR,
    path.dirname(new URL(import.meta.url).pathname),
  ]
  const seen = new Set<string>()
  for (const start of starts) {
    let dir = start
    while (dir && !seen.has(dir)) {
      seen.add(dir)
      const resolved = resolveGitFile(path.join(dir, ".git"))
      if (resolved) return resolved
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return undefined
}

function resolveRefFromPackedRefs(
  gitDir: string,
  ref: string,
): string | undefined {
  try {
    const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8")
    for (const line of packed.split("\n")) {
      if (line.startsWith("#") || line.length === 0) continue
      const [sha, name] = line.split(" ")
      if (name === ref && SHA_RE.test(sha)) return sha
    }
  } catch {
    return undefined
  }
  return undefined
}

function readGitVersion(): GitVersion {
  const dirs = findGitDirs()
  if (!dirs) return { sha: undefined, branch: undefined }

  let head: string
  try {
    head = fs.readFileSync(path.join(dirs.worktree, "HEAD"), "utf8").trim()
  } catch {
    return { sha: undefined, branch: undefined }
  }

  if (SHA_RE.test(head)) return { sha: head, branch: undefined }

  const match = head.match(/^ref: (\S.*)$/u)
  if (!match) return { sha: undefined, branch: undefined }
  const ref = match[1]
  const branch =
    ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined

  // Loose ref may live in either the worktree gitdir (e.g., a
  // worktree-local branch) or the common gitdir (the usual case).
  let sha: string | undefined
  for (const dir of [dirs.worktree, dirs.common]) {
    try {
      const looseRef = fs.readFileSync(path.join(dir, ref), "utf8").trim()
      if (SHA_RE.test(looseRef)) {
        sha = looseRef
        break
      }
    } catch {
      // try next
    }
  }
  sha ??= resolveRefFromPackedRefs(dirs.common, ref)

  return { sha, branch }
}

const cached: GitVersion = readGitVersion()

import { BUILD_GIT_BRANCH, BUILD_GIT_SHA } from "./build-info.gen"

/**
 * In a `bun --compile` binary the .git directory we'd normally read
 * is gone, so `readGitVersion()` returns `{ sha: undefined }` and
 * users see `Git: unknown`. Fall back to the build-time snapshot
 * (scripts/embed-build-info.ts captures HEAD + GITHUB_REF_NAME at
 * build) when the live read produces nothing useful.
 */
export function getGitVersion(): GitVersion {
  if (cached.sha) return cached
  if (BUILD_GIT_SHA && BUILD_GIT_SHA !== "unknown") {
    return { sha: BUILD_GIT_SHA, branch: BUILD_GIT_BRANCH }
  }
  return cached
}

export function shortSha(sha: string | undefined): string {
  if (!sha) return "unknown"
  return sha.slice(0, 7)
}
