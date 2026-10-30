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
bun test             # Run all tests
bun test tests/foo.test.ts  # Run a single test file

# Aggregates
bun run check:fast   # ensure:ui-embed + lint:fast + typecheck + lint:all + check:tokens (the per-edit inner loop)
bun run check:deep   # check:fast + bun test + knip (end-of-task gate)
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
bun run app:setup    # one-time: install shell + broker deps and force-build binaries
bun run app:sidecar  # build the UI + regenerate the embed manifest + rebuild the
                     # standalone proxy and isolated broker into src-tauri/binaries/
                     # (each compile is a no-op when its output is current; override
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

`packages/mcp-broker` and `packages/storybook` each have their own pnpm
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

## Isolated MCP broker package

The broker has its own exact dependency pins, lockfile, and mise tools. Run its
commands from the package so the root Bun dependency state is not changed:

```sh
mise -C packages/mcp-broker exec -- pnpm install --frozen-lockfile
mise -C packages/mcp-broker exec -- pnpm typecheck
mise -C packages/mcp-broker exec -- pnpm test
mise -C packages/mcp-broker exec -- pnpm build
```

The package-local build writes the ignored development binary to
`packages/mcp-broker/dist/maximal-mcp-broker`. `bun run app:sidecar` instead
stages a target-triple broker binary for Tauri. Work IQ is not installed by
these commands; it is an externally configured stdio endpoint.

### Using a brokered endpoint

For Work IQ sign-in, logs and admin approval, see [Work IQ](workiq.md); for
Linux installation and session-keyring access, see
[Work IQ on Linux](linux-workiq.md). Pi has a separate
[connection guide](pi-workiq.md).

Maximal looks for servers it knows (Work IQ, for now) and offers the ones it
finds to add. Anything else can be added from the CLI with its full command
path, or written under `mcpBroker.servers` in `config.json`. An endpoint may set
its own `apiKey`; without one, the normal main-port API-key rules apply.

```sh
maximal mcp                                       # endpoints, and servers to add
maximal mcp workiq --add                          # add Work IQ (found here); off
maximal mcp myserver --add --label "My server" -- /full/path/server --stdio
maximal mcp workiq --enable                       # on; asks which apps get it
maximal mcp workiq --enable --clients claude-code,claude-desktop
maximal mcp workiq --disable                      # off; removed from every app
maximal mcp workiq --remove                       # gone from Maximal and apps
```

`--add` and `--remove` ask to confirm; `--unattended` skips every prompt. Put
`--port` and other flags before `--`; everything after it is the server's
command. The command must be a full path, because Maximal doesn't run servers
with your shell's PATH.

Settings → MCP servers does the same: found servers appear under "Available to
add" (with the install command when one isn't installed), and each added
server has Remove. Only apps whose Maximal integration is on
are offered; turning an app's integration off removes its MCP entries, and
turning it back on restores them. Maximal's entries are removed while Maximal
isn't running and come back when it starts. A same-name MCP server you already
had in an app is left alone; if it is a local command, Maximal runs the same
command for the endpoint (secret-looking environment variables aren't copied).

The CLI applies the change to the running Maximal without a restart; it
finds that instance's port itself (`--port` overrides). App entries always
point at the port Maximal is actually listening on, and follow it if it moves.

Other clients connect to `http://127.0.0.1:<port>/mcp/<id>` (4141 by default)
from the same machine. Stdio-only clients can run
`maximal-mcp-broker stdio-adapter --url http://127.0.0.1:<port>/mcp/<id>` with
`MAXIMAL_MCP_API_KEY` in its environment when a key is required.

Each connected session runs its own copy of the endpoint's server, so Claude
Code, Claude Desktop, or several Claude Code windows can use one endpoint at
the same time. `limits.sessions` on the endpoint caps how many (default 8);
at the cap, the least recently used idle session is closed to make room.

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
# Open http://localhost:4141/ui/settings/  (or /ui/dashboard/)
# Reload the window after a save to pick up changes.
```

`shell/src/main.ts`'s `safeInvoke()` already swallows Tauri-only `invoke()`
calls when running in a plain browser, so the "Reveal in Finder" buttons
no-op gracefully — everything else works.

## Storybook (UI catalog)

Every Settings and Dashboard piece in every state, without a running proxy.
It's an isolated package (`packages/storybook`, its own pnpm lockfile), like
the MCP broker:

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
