# Commands

The repo root uses Bun, not pnpm: `bun.lock` is the lockfile. Running `pnpm`
here stops before installing anything and lists the Bun commands to use
instead (`.pnpmfile.cjs`).

```sh
bun install          # Install dependencies
bun run dev          # Dev mode with watch
bun run build        # Build to dist/ (native Bun import attributes)
bun run start        # Production start (NODE_ENV=production)

# Lint / type / test
bun run lint         # ESLint with cache (auto-fixes staged files pre-commit)
bun run lint:all     # ESLint on entire project
bun run lint:fast    # oxlint — mechanical pass, ~10ms full repo
bun run typecheck    # tsc type check only (no emit)
bun run casts        # inventory TypeScript assertions by source/target safety
bun run casts:check  # fail on unexplained any→concrete boundary assertions
bun test             # Run all tests (root suite under tests/)
bun test tests/foo.test.ts  # Run a single test file
bun run plugins:typecheck   # tsc in every packages/plugin-* workspace
bun run plugins:test        # bun test in every packages/plugin-* workspace
bun run figjam:typecheck    # tsc in every packages/figjam-* workspace that has one
bun run figjam:test         # bun test in every packages/figjam-* workspace
bun run bench:connectors    # real server + Work IQ against a fake upstream (see "Connectors bench")
bun run test:e2e:plugins    # Work IQ through its whole lifecycle in-process, vs. a golden transcript

# Aggregates
bun run check:fast   # ensure:ui-embed + lint:fast + typecheck + plugins:typecheck + figjam:typecheck + lint:all + casts:check + check:tokens (the per-edit inner loop)
bun run check:deep   # check:fast + bun test + plugins:test + figjam:test + knip (end-of-task gate)
bun run deps:check   # dependency-cruiser layer rules
bun run knip         # find unused exports/files
bun run git:tidy     # plan branch cleanup (archive-then-delete); --apply to act

# Mutation testing (manual only — not wired into check:deep)
bun run mutate       # Stryker; configure module under test in stryker.conf.*

# Release tooling
bun run release:manual  # local fallback version commit + tag (bumpp). Primary
                        # release path is release-please: merge the auto-opened
                        # release PR → tag → release.yml builds/publishes assets.

# Tauri app (menu-bar shell wrapping the proxy as a sidecar on :4141)
bun run app:setup    # one-time: install shell deps and force-build the sidecar
bun run app:sidecar  # build the UI + regenerate the embed manifest + rebuild the
                     # standalone proxy into src-tauri/binaries/
                     # (the compile is a no-op when its output is current; override
                     # with --force or MAXIMAL_FORCE_SIDECAR=1 — release pipelines
                     # must set it)
bun run app:dev      # build sidecar (if stale) + tauri dev
                     # Each worktree gets a persisted random app identifier,
                     # that identifier's platform-native Tauri app-data profile,
                     # and an OS-selected loopback port that is persisted for a
                     # stable webview origin. An explicit COPILOT_API_HOME is
                     # resolved and used instead of the default.
bun run app:ui       # UI-only iteration: `bun run build:ui --watch` — rebuilds the
                     # settings + dashboard bundles into shell/dist on every save.
                     # Run `bun run dev` in another terminal so the sidecar serves
                     # them at :4141/ui/* (reload the window to pick up changes).
bun run app:build    # force-rebuild sidecar + tauri build --bundles app,dmg
bun run app:build:test # build an app bundle with the non-production test identifier
bun run app:windows:setup # macOS only: install the scoped cargo-xwin toolchain
bun run app:windows:check # compile-check the Windows Tauri shell from macOS
bun run app:windows:build # stage a Windows VM payload under dist-windows/
```

`bun run start`, `bun run dev` and `maximal start` listen on `127.0.0.1` unless
`HOST` is set. To serve other machines, set `HOST=0.0.0.0` (every interface) or
`HOST=::`; `src/lib/start/listen-host.ts` owns the default. Request auth lets
every caller through by default, so expose it only on a trusted network.

Installing a released Maximal on Debian or Ubuntu (apt, the user service,
updates) is covered in [Maximal on Linux](linux.md). The Linux packages are
built by `build/linux/` scripts; to try one locally, compile the binaries for
a `bun-linux-*` target and run, for example:

```sh
build/linux/build-maximal-deb.sh 0.6.0 arm64 <dir-with-binaries> <out-dir>
docker run --rm -v "$PWD:/src:ro" -v "<out-dir>:/debs:ro" \
  -e MAXIMAL_SMOKE_SKIP_DESKTOP=1 debian:13 \
  bash /src/build/linux/smoke-deb.sh 0.6.0 /debs
```

`build-maximal-deb.sh` needs `dpkg-deb`, so run it on Debian/Ubuntu (or in an
`ubuntu:24.04` container).

## pnpm lockfiles and the package feed

`packages/storybook` has its own pnpm
lockfile. The package feed serves tarballs from `ms-feed-N` hosts that rotate,
and a lockfile that records one fails a later `--frozen-lockfile` install. Each
package's `.pnpmfile.cjs` drops those URLs as pnpm writes the lockfile (pnpm
rebuilds them from the registry), and CI checks the committed files. To repair a
lockfile that has them anyway:

```sh
bun scripts/strip-lockfile-hosts.ts          # drop recorded shard hosts
bun scripts/strip-lockfile-hosts.ts --check  # what CI runs
```

Editing a package's `.pnpmfile.cjs` changes its lockfile's `pnpmfileChecksum`:
run `pnpm install` in that package and commit the lockfile with it.

## Connectors bench

Run the whole Connectors experience — Settings → Integrations → Connectors and
the `/mcp/workiq` endpoint — with the real Work IQ connector but no Microsoft
account, tenant or network:

```sh
bun run build:ui                                # once, for the Settings page
bun run bench:connectors                        # serve until Ctrl-C
bun run bench:connectors --drive                # scripted MCP session, pass/fail table, exit 1 on failure
bun run bench:connectors --entitlement=partial  # tenant allows only the read-only tools
bun run bench:connectors --entitlement=none     # account not enabled: the admin error state
bun run bench:connectors --port=4242 --verbose
```

It starts a fake Work IQ MCP server (the connector kit's fake, seeded with the
Work IQ fixture: 14 tools, read-only 6 / write-delete 5 / other 3, canned fake
answers) and the real Maximal server (`runServer`) composing the Work IQ
connector pointed at it, with a sign-in that completes instantly as
bench@contoso.com. Everything runs in a throwaway user environment (HOME, app
data, Claude config) that is deleted on exit, so nothing touches your real
setup. It prints the Settings URL, the MCP endpoint and an API key (for
attribution; "Block unknown connections" stays off so the page works in a
browser) and a ready-to-paste `claude mcp add` line.

`--drive` accepts the terms and signs in through the Settings API, checks the
tool groups, lists tools over MCP, blocks a tool (the client gets
`tools/list_changed`, the tool disappears, a call is refused), unblocks it,
calls an allowed tool, injects a policy-denied (HTTP 403) call that must come
back as an `isError` result while the connector stays ready, and prints a
pass/fail table. `tests/bench-connectors.test.ts` runs the same drive
in-process under `bun test`.

## Parked MCP broker

The MCP broker and its `maximal mcp` command are parked under `parked/mcp/`
and are not built or tested. Work IQ is now a built-in plugin (Settings →
Integrations → Connectors; see [`workiq.md`](workiq.md)).

## Fast UI iteration

For HTML/CSS/TS changes under `shell/ui/` or `shell/src/`, **do not** run
`app:dev` — the sidecar binary is a 66 MB Bun compile (~30–90s). Instead run
the proxy from source (it serves the UI from `shell/dist` on disk) and a
watch-build:

```sh
# Terminal A — proxy from source with file watch, bound to :4141.
bun run dev -- start --port 4141

# Terminal B — rebuild the UI bundles on every save.
bun run app:ui
# Open http://localhost:4141/ui/settings/, /ui/dashboard/, or /ui/sessions/
# Reload the window after a save to pick up changes.
```

`shell/src/main.ts`'s `safeInvoke()` already swallows Tauri-only `invoke()`
calls when running in a plain browser, so the "Reveal in Finder" buttons
no-op gracefully — everything else works.

## Storybook (UI catalog)

Every Settings, Dashboard and Sessions piece in every state, without a running proxy.
It's an isolated package (`packages/storybook`, its own pnpm lockfile):

```sh
bun run storybook:install   # once, or after packages/storybook/pnpm-lock.yaml changes
bun run storybook           # dev server on :6006; restages the window stories on save
bun run storybook:build     # static build → packages/storybook/storybook-static
bun run storybook:check     # fixtures vs. API schemas + stories vs. component props
```

CI runs `storybook:check` on every push and PR. Run it locally after changing a
UI component's props or a `settings-types` schema; it fails on
a story whose props no longer match the component, and on a fixture that no
longer matches the wire contract.

It shares its mock backend and fixtures with `bun run ui:harness`
(`scripts/ui-harness-api.ts`, `scripts/ui-harness-fixtures.ts`). Use the harness
to click through the whole app against one scenario, and Storybook to see
each piece in each state side by side. Details: `packages/storybook/README.md`.

## Browser tests (Playwright)

`tests/e2e/*.spec.ts` drive the built UI in Chromium against the harness, for
what happy-dom can't see: layout, hit targets, timing. They are not part of
`bun test` (bunfig.toml ignores `tests/e2e/`) or CI; `bun run test:e2e` runs
them all.

```sh
bunx playwright install chromium               # once
bun run ui:harness -- --port 4747              # terminal A (builds the UI first)
bun run test:e2e                               # terminal B; UI_HARNESS_URL for another port
```

Screenshots the specs take land in `test-results/` (gitignored) for you to
look at; nothing is compared against a baseline.
