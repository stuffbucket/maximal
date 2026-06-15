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
bun run app:sidecar  # rebuild standalone proxy binary into shell/src-tauri/binaries/
                     # (no-op when binary is newer than src/; override with --force
                     # or MAXIMAL_FORCE_SIDECAR=1 — release pipelines must set it)
bun run app:dev      # build sidecar (if stale) + tauri dev (hot-reload)
bun run app:ui       # UI-only iteration: Vite alone at :1420. Run `bun run dev`
                     # in another terminal so the UI's API calls (which target
                     # :4141 in DEV mode) hit a live proxy. Far faster than
                     # spinning the whole Tauri shell for HTML/CSS tweaks.
bun run app:build    # force-rebuild sidecar + tauri build --bundles app,dmg
```

## Fast UI iteration

For HTML/CSS/TS changes under `shell/src/`, **do not** run `app:dev`. The
sidecar binary is a 66 MB Bun compile (~30–90s) and Vite already does
HMR for the UI. Instead:

```sh
# Terminal A — proxy with file watch, bound to :4141 (matches shell/src/api.ts DEV branch).
bun run dev -- start --port 4141

# Terminal B — Vite for the settings UI.
bun run app:ui
# Open http://localhost:1420/settings/
```

`shell/src/main.ts`'s `safeInvoke()` already swallows Tauri-only `invoke()`
calls when running in a plain browser, so the "Reveal in Finder" buttons
no-op gracefully — everything else works.
