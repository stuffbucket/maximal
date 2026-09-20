# Live-test build readiness checklist

Getting a host `bun run app:dev` build that actually contains the changes you
want to test live — and **confirming** it does, rather than assuming.

## The problem this solves

There is no automatic link between "merged to `main`" and "in the running
sidecar." The Tauri sidecar is a compiled binary; `bun run app:dev` only
recompiles it when its sources changed (see `scripts/build-sidecar.ts` →
`isUpToDate`). A sidecar built from an older commit silently omits everything
merged since. Symptom: the proxy on `:4141` reports an old commit in its
`x-maximal-version` header while `origin/main` has moved on.

## How "which commit is running" is knowable

`scripts/build-sidecar.ts` stamps the binary at compile time:

```
version = `${pkg.version}-dev+${git rev-parse HEAD (first 8 chars)}`
```

injected via `bun build --compile --define __MAXIMAL_VERSION__=...`. That value
becomes `BUILD_VERSION` (`src/lib/build-info.ts`) and the proxy echoes it on
**every** response as the `x-maximal-version` header (`src/server.ts`). So the
`+<sha>` suffix **is** the source commit the running binary was built from —
that's exactly what `bun run verify:build` compares against `origin/main`.

Release binaries (no `.git`) omit the `+<sha>` suffix; `verify:build` reports
`UNKNOWN` for those since they can't be mapped to a commit.

## Steps to a testable build

1. **Get to `origin/main` HEAD.**
   ```sh
   git checkout main && git pull
   git fetch origin main        # so verify:build can resolve origin/main
   ```

2. **(For #252 only) set the config flag the E2E test needs.**
   `promptCacheRetention` is config-gated and defaults UNSET, so #252's
   `/responses` 24h prefix-cache retention is inert until you opt in. Edit the
   config file the app reads:

   - macOS / Linux: `~/.local/share/maximal/config.json`
   - Windows: `%APPDATA%\maximal\config.json`
   - Override (any platform): `$COPILOT_API_HOME/config.json`

   Add:
   ```json
   { "promptCacheRetention": "24h" }
   ```
   (Path resolution mirrors `src/lib/paths.ts` → `resolveAppDir`.)

3. **Rebuild + relaunch the sidecar.**
   ```sh
   bun run app:dev
   ```
   If the binary looks "up to date" but you still need a rebuild (e.g. only a
   dependency or a pulled commit changed mtimes oddly), force it:
   ```sh
   MAXIMAL_FORCE_SIDECAR=1 bun run app:dev
   ```

4. **CONFIRM before you measure.**
   ```sh
   bun run verify:build
   ```
   Expect `Verdict: PASS  running build <sha> == origin/main <sha>` and
   `promptCacheRetention: 24h → #252 E2E READY`. If it says `STALE`, the
   sidecar didn't pick up your pull — rebuild (step 3, with the force env).
   Exit codes: `0` PASS, `1` STALE/UNKNOWN/AHEAD, `2` proxy unreachable.
   Point at another port with `--base-url http://127.0.0.1:4142` or
   `MAXIMAL_BASE_URL`.

5. **Measure.** Use the harness (`scripts/dev/measure-baseline.ts`):
   ```sh
   # before/after single-run snapshot
   bun run measure:baseline -- --label after

   # #252: prove 24h retention with a long inter-request gap (15 min)
   bun run measure:baseline -- --label after --cache-gap-ms 900000

   # honest A/B (interleaved, significance-tested) against another proxy
   bun run measure:baseline -- --label old-vs-new \
     --base-url http://127.0.0.1:4141 --compare http://127.0.0.1:4142 --samples 20
   ```

## What each merged change needs to be testable

| Change | In the sidecar binary? | How to confirm it's active |
|---|---|---|
| **#246** web-tools streaming (usage aggregation + keepalive pings) | **Yes** — `src/` code | Build sha ≥ #246's merge (`verify:build` PASS). Exercise a streamed web-tools request; usage totals aggregate and keepalive pings arrive during long streams. |
| **#252** `prompt_cache_retention` on `/responses` | **Yes** — `src/` code, **config-gated** | `verify:build` PASS **and** `promptCacheRetention: "24h"` set (step 2). E2E: `measure:baseline --cache-gap-ms 900000` on a `/responses` GPT model — a 24h-retained prefix still shows `cache_read_input_tokens` after the gap. |
| **#253** measurement harness | **No** — dev script only (`scripts/dev/measure-baseline.ts`) | Not shipped in the binary. Run it directly from the checked-out tree; nothing to verify in the running proxy. |
| **#255** dispersion stats + A/B significance | **No** — dev script only (extends `measure-baseline.ts`) | Same as #253 — run the script from the tree; `--compare` prints a Mann–Whitney verdict. |

Only sidecar-code changes (#246, #252) require a rebuild + `verify:build` PASS.
Dev-only script changes (#253, #255) take effect as soon as they're in your
working tree — they are not part of the compiled sidecar.
