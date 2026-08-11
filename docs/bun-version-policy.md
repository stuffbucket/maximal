# Bun version policy

Pinned in `.bun-version` (read by Bun's own version manager) AND in
`.github/workflows/ci.yml`. Both must move together — dev/CI drift is
what got us a 22-test failure on a Bun `latest` regression once, and the
pin is the antidote.

**This pins the runtime, not the installer.** pnpm installs dependencies
here; Bun runs the tests and builds the bundle. So this version governs
`bun test` and `bun build`, and a Bun regression can still break the
suite exactly as it did before — which is why the pin stays. The
installer's own version is pinned separately, in `package.json`'s
`packageManager` field.

`site-ci.yml` instead reads `.bun-version` at runtime (a `cat .bun-version`
step feeding `setup-bun`), so it holds no copy to drift; only
`.bun-version` and `ci.yml` need the manual bump below.

Bump intentionally:

1. Pick the new Bun version (read its release notes — confirm no
   open regressions affecting our patterns: parallel test loading,
   module-export resolution, `with { type: "file" }` import
   attributes).
2. Run the whole suite locally on the new version: `bun test`,
   `bun run check:fast`, `bun run build`.
3. If green, update **both** `.bun-version` and the `bun-version`
   field in `.github/workflows/ci.yml` in the same commit.
4. Watch the next CI run.

Don't float `latest`. Bun ships fast; a release in a single afternoon
can ship a regression that breaks our test loader, and the difference
between "we picked this Bun" and "CI happened to pull this Bun" is
the difference between a one-line fix and an hour of triage.

Cadence: rev every ~4-6 weeks for hygiene, or sooner when a needed
feature/fix lands upstream. Don't let the pin go stale enough to
miss security fixes.
