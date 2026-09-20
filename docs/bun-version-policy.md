# Bun version policy

Pinned in `.bun-version` (read by `bun install` and Bun's own version
manager) AND in `.github/workflows/ci.yml`. Both must move together —
dev/CI drift is what got us a 22-test failure on a Bun `latest`
regression once, and the pin is the antidote.

Bump intentionally:

1. Pick the new Bun version (read its release notes — confirm no
   open regressions affecting our patterns: parallel test loading,
   module-export resolution, `with { type: "file" }` import
   attributes).
2. Run the whole suite locally on the new version: `bun test`,
   `bun run check:fast`, `bun run app:dev`.
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
