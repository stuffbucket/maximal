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
bun run knip         # find unused exports/files
bun run verify:build # smoke-check the built CLI

# Release tooling
bun run release:manual  # local fallback cut (bumpp + bun publish). Primary
                        # release path is release-please: merge the auto-opened
                        # release PR → tag → release.yml builds/publishes.
bun run render-formula  # regenerate the Homebrew formula
bun run sbom            # generate the SBOM
bun run scan:secrets    # trufflehog filesystem scan
```

`dev`, `build`, and `start` all run the proxy engine out of
`@stuffbucket/maximal-core` — this repo packages and ships it, but the engine
source lives in that separate repo.

## Electron client (`client/`)

`client/` is the desktop app. It is managed by **npm, not Bun**:

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
