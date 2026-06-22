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
bun run release:manual  # local fallback cut (bumpp + bun publish). Primary
                        # release path is release-please: merge the auto-opened
                        # release PR → tag → release.yml builds/publishes.

# Tauri app (menu-bar shell wrapping the proxy as a sidecar on :4141)
bun run app:setup    # one-time: install shell deps + force-build sidecar binary
bun run app:sidecar  # build the UI + regenerate the embed manifest + rebuild the
                     # standalone proxy binary into shell/src-tauri/binaries/
                     # (compile is a no-op when the binary is newer than src/;
                     # override with --force or MAXIMAL_FORCE_SIDECAR=1 — release
                     # pipelines must set it)
bun run app:dev      # build sidecar (if stale) + tauri dev
bun run app:ui       # UI-only iteration: `bun run build:ui --watch` — rebuilds the
                     # settings + dashboard bundles into shell/dist on every save.
                     # Run `bun run dev` in another terminal so the sidecar serves
                     # them at :4141/ui/* (reload the window to pick up changes).
bun run app:build    # force-rebuild sidecar + tauri build --bundles app,dmg
```

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
