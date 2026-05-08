# Phase 2 — Build simplification

## 30-second context

Replace the current `tsdown` + `embed-usage-viewer.ts` + `bun build --compile`
pipeline with a single Bun toolchain that uses native asset embedding. Removes
the codegen seam that birthed the `B:\~BUN\root\…` ENOENT bug class and
collapses two-way drift between dev (`bun run start`) and prod
(`bun --compile`) loaders.

## Goals

1. One toolchain (`bun`) for both `dist/` library output and
   `dist-bin/maximal[.exe]` compiled binary.
2. Native asset embedding via `with { type: "file" }` — no codegen, no
   read-time path resolution gymnastics.
3. Build Windows binaries on a Windows runner so `--windows-icon`,
   `--windows-hide-console`, version/publisher/title metadata actually take
   effect.

## Non-goals

- Replacing tsdown for a published-as-library use case. Maximal is a CLI/server
  binary, not an npm library. If we ever ship a public `@stuffbucket/maximal`
  npm package with `.d.ts`, we'd revisit.
- Reorganizing the source tree. The change is purely tooling.

## Design

### 2.1 Drop `tsdown`, use `bun build`

```jsonc
// package.json
"scripts": {
  "build": "bun build src/main.ts --target=bun --outdir dist --sourcemap=linked"
}
```

Delete `tsdown.config.ts`, `tsdown` devDep. Output is a single `dist/main.js`
(plus splits if `--splitting` is later added) — the same shape `bun run start`
imports from `dist`-relative paths.

### 2.2 Native asset embedding

Replace `scripts/embed-usage-viewer.ts` + `src/pages/usage-viewer.gen.ts` with
a single import attribute at the call site:

```ts
// src/server.ts
import usageViewerHtml from "./pages/usage-viewer.html" with { type: "file" }

server.get("/usage-viewer", (c) =>
  c.html(Bun.file(usageViewerHtml).text()),
)
```

At build time `bun build` reads the file, embeds bytes, rewrites the import
to a `$bunfs/<hash>` path. At runtime `Bun.file()` and `node:fs/readFileSync`
both work, identically across `bun run dev`, `bun run start`, and the
compiled binary on macOS / Windows / Linux.

`scripts/embed-usage-viewer.ts` deleted. `src/pages/usage-viewer.gen.ts`
deleted (was a build artifact, never should have been tracked).

### 2.3 Compile invocation

Unchanged shape, additions:

```sh
bun build --compile --minify --sourcemap --bytecode \
  --asset-naming="[name].[ext]" \
  --target=bun-${{ matrix.target }} src/main.ts \
  --outfile dist-bin/maximal${{ matrix.exeSuffix }}
```

- `--bytecode` — moves parse cost to build time. Single biggest free win on
  startup latency.
- `--asset-naming="[name].[ext]"` — stable filenames inside the embedded fs
  (no content-hash churn between identical builds).

### 2.4 Windows on Windows

`release.yml` matrix changes:

```yaml
matrix:
  include:
    - { target: bun-darwin-arm64, runner: ubuntu-latest, ... }
    - { target: bun-windows-x64,  runner: windows-latest, exeSuffix: .exe, ... }
```

Windows runner unlocks `--windows-icon=build/windows/maximal.ico`,
`--windows-hide-console=true`, and the version/publisher/title metadata
fields. macOS arm64 keeps cross-compiling from Linux until signing lands
(Phase 5 territory).

## Acceptance

- `rm -rf dist dist-bin && bun run build && bun run start` produces identical
  behavior to today, including `/usage-viewer` rendering correctly.
- `bun build --compile ...` produces a binary that, when extracted, runs
  `/usage-viewer` correctly without any working-dir-relative reads.
- The Windows binary's Properties dialog (right-click → Properties →
  Details) shows our publisher/version metadata.
- `scripts/embed-usage-viewer.ts` and `src/pages/usage-viewer.gen.ts` no
  longer exist in the repo.

## Estimate

One day. Zero new tests required; existing 239 tests cover the runtime path.

## Open questions

1. Is `--bytecode` stable enough for production binaries in 2026-Q2? Spike: if
   it adds binary size by >20% or breaks any tests, defer.
2. Do we want to keep an `npm pack`-able artifact for any reason? If yes,
   tsdown stays. (Current answer: no.)
