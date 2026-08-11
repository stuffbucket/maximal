# Commands

```sh
pnpm install         # Install dependencies (pnpm installs; Bun runs)
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

# Mutation testing (manual only — not wired into check:deep)
bun run mutate       # Stryker; configure module under test in stryker.conf.*

# Release tooling
bun run release:manual  # local fallback cut (bumpp + bun publish). Primary
                        # release path is release-please: merge the auto-opened
                        # release PR → tag → release.yml builds/publishes.

# Tauri app (menu-bar shell wrapping the proxy as a sidecar on :4141)
# Still live today, but being replaced by client/ (below) — a minimal pointer,
# not a full workflow guide.
bun run app:setup    # one-time: install shell deps + force-build sidecar binary
bun run app:dev      # build sidecar (if stale) + tauri dev
```

## Electron client (`client/`)

`client/` is a separate Electron app under active development as the
replacement for the Tauri `shell/` — **both exist today**, don't assume
one has replaced the other. It is managed by **npm, not Bun**:

```sh
cd client
npm install          # Install dependencies (npm, not bun)
npm run build:core   # Compile the maximal-core sidecar (uses bun under the hood)
npm run typecheck    # tsc --noEmit
npm run test         # Vitest, watch mode
npm run test:run     # Vitest, single run (what CI runs)
npm start            # electron-forge start
npm run package      # electron-forge package
```

Bun is only invoked internally by `build:core` to compile the extracted
`@stuffbucket/maximal-core` proxy engine into a sidecar binary — every other
`client/` command runs through npm/Node. CI for `client/` runs in its own
workflow, `.github/workflows/client-ci.yml`, separate from the root `ci.yml`.
