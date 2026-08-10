import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

// e2e/support -> client -> repo root
const CLIENT_DIR = resolve(__dirname, '..', '..')
const REPO_ROOT = resolve(CLIENT_DIR, '..')

export interface RelocatedApp {
  /** Path to the relocated copy of the packaged .app (outside the repo). */
  appPath: string
  /** Root temp directory holding the copy; remove this (recursively) to clean up. */
  root: string
}

function packagedAppSourcePath(): string {
  if (process.platform !== 'darwin') {
    throw new Error(
      `Packaged-app e2e only knows how to find a build for darwin today (running on ${process.platform}). ` +
        'build-core.ts currently only targets bun-darwin-arm64.',
    )
  }
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch
  const candidate = join(CLIENT_DIR, 'out', `Maximal-darwin-${arch}`, 'Maximal.app')
  if (!existsSync(candidate)) {
    throw new Error(
      `No packaged app found at ${candidate}.\n` +
        'Run `npm run package` in client/ before the e2e suite — this harness never builds it for you, ' +
        'so a missing package fails loudly instead of silently skipping.',
    )
  }
  return candidate
}

/**
 * Copy the packaged .app to a fresh directory OUTSIDE the repo (and therefore
 * outside every node_modules in its ancestry), then assert both things held.
 *
 * WHY THIS EXISTS (non-negotiable, not theoretical):
 * stuffbucket/maximal-electron#154 measured the IDENTICAL build hanging for
 * 180 seconds when launched in place from `out/`, vs. ~0.7s launched from a
 * relocated copy — because the in-place run resolved an unshipped native
 * backend from the checkout's parent `node_modules`. A test that runs the
 * app from `out/` tests a bundle no user will ever run, and it would pass
 * while the shipped artifact is broken. Every packaged-app check MUST go
 * through this relocation first.
 */
export function relocatePackagedApp(): RelocatedApp {
  const source = packagedAppSourcePath()
  const root = mkdtempSync(join(tmpdir(), 'maximal-e2e-'))

  assertOutsideRepoTree(root)

  const dest = join(root, 'Maximal.app')
  execFileSync('cp', ['-R', source, dest])

  assertCopyComplete(source, dest)
  assertNoAncestorNodeModules(root)

  return { appPath: dest, root }
}

function assertOutsideRepoTree(path: string): void {
  const normalizedRepo = REPO_ROOT.endsWith(sep) ? REPO_ROOT : REPO_ROOT + sep
  if (path === REPO_ROOT || path.startsWith(normalizedRepo)) {
    throw new Error(
      `Relocation target ${path} is still inside the repo (${REPO_ROOT}) — the whole point is to escape it.`,
    )
  }
}

/**
 * `diff -rq` recursively compares every file's contents between source and
 * destination and throws (via execFileSync's nonzero-exit behaviour) if
 * anything is missing, extra, or byte-different on either side. This is the
 * "assert the copy is complete" requirement — a truncated `cp` (disk full,
 * killed mid-copy) fails this immediately rather than silently launching a
 * half-copied bundle.
 *
 * stderr is discarded: macOS `.framework` bundles version their contents via
 * `Versions/Current -> A` symlinks (plus `Resources`/`Helpers`/`Libraries`
 * symlinks into that), and `diff -r`'s cycle detection reports a harmless
 * "Directory loop detected" for those on BOTH sides of every comparison —
 * confirmed by exit code (0) that this is warning noise, not a real
 * completeness gap. Actual differences (`Files … differ`, `Only in …`) are
 * written to stdout, which is left connected, so a genuine mismatch still
 * throws with a useful message.
 */
function assertCopyComplete(source: string, dest: string): void {
  execFileSync('diff', ['-rq', source, dest], { stdio: ['ignore', 'pipe', 'ignore'] })
}

/**
 * Walk from `startDir` up to `/` and confirm no ancestor holds a
 * `node_modules` directory.
 *
 * This is the structural guarantee behind "the app cannot resolve a
 * dependency from above its own directory": Node/Bun module resolution walks
 * up parent directories looking for `node_modules`, so if none exist above
 * the relocated copy, nothing above it is reachable by that mechanism — which
 * is exactly the class of bug #154 found (an unshipped native backend
 * resolved from the checkout's parent `node_modules`). If this ever fires it
 * means the relocation regressed back into some directory that is still
 * inside (or shares an ancestor with) a dependency tree.
 */
function assertNoAncestorNodeModules(startDir: string): void {
  let dir = resolve(startDir)
  for (;;) {
    const candidate = join(dir, 'node_modules')
    if (existsSync(candidate)) {
      throw new Error(
        `Found node_modules at ${candidate} while walking up from ${startDir} — relocation did not escape the dependency tree.`,
      )
    }
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
}
