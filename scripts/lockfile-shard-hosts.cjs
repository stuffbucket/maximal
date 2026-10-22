/**
 * Rotating package-feed shard hosts, kept out of pnpm lockfiles.
 *
 * The registry (NPM_CONFIG_REGISTRY in mise.toml) serves tarballs from
 * `ms-feed-N` hosts whose number rotates. pnpm records whichever host
 * answered as the entry's `tarball:` URL, then on a later install rejects it
 * (ERR_PNPM_LOCKFILE_RESOLUTION_VERIFICATION) once the registry's metadata
 * names a different shard, and that check runs before any lifecycle script.
 * Without a `tarball:` field pnpm rebuilds the URL from the configured
 * registry, so the fix is to drop the field. Only shard-host URLs are
 * dropped: any other tarball URL (a git or release dependency) is pinned on
 * purpose. Integrity hashes are untouched.
 *
 * Shared by each pnpm package's `.pnpmfile.cjs` (drops them before the
 * lockfile is written) and `scripts/strip-lockfile-hosts.ts` (repairs a
 * lockfile that already has them), so the two can't drift. Adapted from
 * monimal's scripts/lockfile-shard-hosts.cjs. CommonJS because pnpm loads
 * pnpmfiles with require().
 */

const SHARD_HOST = /https?:\/\/ms-feed-\d+\.pkgs\.visualstudio\.com(?=[:/]|$)/

/**
 * Remove shard-host tarball URLs from a parsed lockfile, in place.
 *
 * @param {{ packages?: Record<string, { resolution?: { tarball?: string } }> }} lockfile
 * @returns {{ dropped: number, inspected: number }}
 */
function dropShardHostUrls(lockfile) {
  const packages = lockfile?.packages
  // A lockfile shape without `packages` would make this a silent no-op and
  // hosts would quietly be committed again, so say so. Not thrown: failing
  // every install is worse, and CI still checks the committed file.
  if (packages === null || typeof packages !== "object") {
    console.warn(
      "pnpmfile: lockfile has no `packages` map; shard hosts were NOT dropped."
        + " The lockfile format may have changed (scripts/lockfile-shard-hosts.cjs).",
    )
    return { dropped: 0, inspected: 0 }
  }
  let dropped = 0
  let inspected = 0
  for (const entry of Object.values(packages)) {
    const tarball = entry?.resolution?.tarball
    if (typeof tarball !== "string") continue
    inspected += 1
    if (!SHARD_HOST.test(tarball)) continue
    delete entry.resolution.tarball
    dropped += 1
  }
  return { dropped, inspected }
}

/** The pnpmfile for a package with its own lockfile. */
function lockfileHooks() {
  return {
    hooks: {
      afterAllResolved(lockfile) {
        const { dropped } = dropShardHostUrls(lockfile)
        if (dropped > 0) {
          console.log(
            `pnpmfile: dropped ${dropped} rotating shard-host tarball URL(s) from the lockfile`,
          )
        }
        return lockfile
      },
    },
  }
}

module.exports = { SHARD_HOST, dropShardHostUrls, lockfileHooks }
