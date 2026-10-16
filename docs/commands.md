# Commands

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
bun run check:fast   # lint:fast + typecheck + lint:all (the per-edit inner loop)
bun run check:deep   # check:fast + bun test + knip (end-of-task gate)
bun run deps:check   # dependency-cruiser layer rules
bun run knip         # find unused exports/files

# Optional: meta-analysis stream
bun run analyze      # tails .claude/logs/checks.jsonl into a local Ollama model

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
bun run app:ui       # UI-only iteration: `bun run build:ui --watch` — rebuilds the
                     # settings + dashboard bundles into shell/dist on every save.
                     # Run `bun run dev` in another terminal so the sidecar serves
                     # them at :4141/ui/* (reload the window to pick up changes).
bun run app:build    # force-rebuild sidecar + tauri build --bundles app,dmg
```

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
the same time. `limits.sessions` on the endpoint caps how many (default 8).

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

Storybook is ad-hoc tooling and deliberately not in CI. Run `storybook:check`
after changing a UI component's props or a `settings-types` schema; it fails on
a story whose props no longer match the component, and on a fixture that no
longer matches the wire contract.

It shares its mock backend and fixtures with `bun run ui:harness`
(`scripts/ui-harness-api.ts`, `scripts/ui-harness-fixtures.ts`). Use the harness
to click through the whole app against one scenario, and Storybook to see
each piece in each state side by side. Details: `packages/storybook/README.md`.
