// Keeps rotating package-feed shard hosts out of this package's lockfile, as
// pnpm writes it (see scripts/lockfile-shard-hosts.cjs). Editing this file
// changes `pnpmfileChecksum` in pnpm-lock.yaml; re-run `pnpm install` here
// and commit the lockfile with it, or frozen installs fail.
module.exports = require("../../scripts/lockfile-shard-hosts.cjs").lockfileHooks()
