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

## The MCP broker's own pin

`packages/mcp-broker` builds a separate binary with its own toolchain, so
its Bun lives in `packages/mcp-broker/mise.toml`, not `.bun-version`. CI
and the release read it through `mise -C packages/mcp-broker`. It can
move independently of the main pin.

Keep it at **1.4.0 or later**. Bun 1.3's `node:http` gives a server no
sign that a client dropped a streaming response once the request has
been read: no response or socket `close`, no write error. The broker
then never sees an abandoned MCP session's stream end, never reclaims
the session, and runs out of session slots. Bun 1.4.0 rewrote
`node:http` and behaves like Node here. The broker's "killed outright"
adapter test fails on any Bun without the fix.
