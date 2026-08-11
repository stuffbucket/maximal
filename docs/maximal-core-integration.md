# maximal client on the electron shell — architecture + build-dependency plan

Status: **PLAN — for review, no code written yet.** Supersedes the earlier
(backwards) draft of this file, which put maximal-core *inside* the electron repo.

## The corrected direction

Three independently-versioned pieces. Nothing carries another's source.

```
┌────────────────────────────┐   ┌────────────────────────────────┐
│  @stuffbucket/maximal-core  │   │  electron shell (generic)      │
│  the proxy ENGINE           │   │  windows, terminal, overlay,   │
│  (headless, /control API)   │   │  agent framework, IPC, build/  │
│  published, tagged          │   │  signing — MAXIMAL-AGNOSTIC    │
└──────────────┬─────────────┘   └───────────────┬────────────────┘
               │  git-dep #vX                     │  git-dep #vY
               └───────────────┬──────────────────┘
                       ┌───────▼────────┐
                       │ maximal CLIENT │   NEW, built in the maximal repo
                       │ composes both  │   maximal-specific UI + wiring:
                       │ + its own UI   │   spawns core, renders /control,
                       └────────────────┘   models/diagnostics/api-keys views
```

Rules that fall out of this:

- **The electron shell never imports maximal-specific code.** It knows nothing
  about maximal-core. maximal may *drive requirements* into it, but only as
  **general capabilities** (e.g. "the shell can spawn and supervise a sidecar
  process", "the shell has a settings-panel framework") — never "spawn
  maximal-core". The maximal-core spawn/wiring lives in the **maximal client**.
- **The maximal client is a new Electron app in the maximal repo** that depends
  on the electron shell + maximal-core (both as versioned deps) and adds the
  maximal-specific surface. It reuses the electron shell's pre-work (terminal,
  overlay, packaging/signing) rather than reinventing it.
- **Tauri is done** — parked at `platform/tauri` / tag `tauri-v0.4.41`, not
  developed further. The maximal client replaces it.
- **Independent cadence.** maximal pins `electron-shell#vY` and
  `maximal-core#vX`; neither project is forced to take the other's every update.
  This is the same decoupling maximal-core already has, now applied to the shell.

## The first integration point: build dependencies (this is the task)

Before any UI, make the **dependency + build wiring** real so the three pieces
can move independently. That is the whole of the first milestone.

### The honest hard part

The electron repo is an **app, not a library** (`package.json`: `main:
.vite/build/main.js`, no `exports`; native deps `node-pty`/`node-llama-cpp`
packaged at the app level by Forge). You cannot just `npm install` it and get a
shell. Making it a consumable dependency needs a deliberate library surface, and
the **native-module packaging across the dependency boundary is the main risk** —
Forge packs native prebuilds for the *final* app, so those must be direct deps of
the maximal client, with the shell referencing them as **peer deps**.

### Recommended model (Model 1): electron publishes a reusable shell; maximal owns the app

- **electron repo** gains a library surface (an `exports` map) over the reusable,
  already-modular parts:
  - `.../main` — lifecycle + IPC-registration framework, window factories, native
    capability modules (pty, agent, tray, updates, preferences, menu).
  - `.../preload` — the contextBridge framework.
  - `.../renderer` — shell primitives (TitleBar, TabBar, LeftNav, Canvas,
    Inspector, TerminalView) + bridge hooks + design tokens.
  - `.../shared` — the typed IPC contract + its exhaustiveness framework.
  - `.../build` — a Forge config preset + Vite config factories + the
    `verify-package` helper (so consumers don't hand-copy the native-module
    `ignore`/`unpack`/`extraResource` dance).
  - Native modules (`node-pty`, `node-llama-cpp`) become **peerDependencies**.
  - The demo tree (`components/demo/*`, gated by `?demo=1`) stays app-only, not
    exported — it's reference content, not shell.
  - Tag releases (`v0.1.0`, …) exactly like maximal-core; maximal consumes
    `github:stuffbucket/electron#vY` (public → anonymous install).
- **maximal client** = a new Electron app (e.g. `maximal/client/` or a sibling)
  with its **own** Forge/Vite config (built from the shell's presets), direct deps
  on the native modules + `electron-shell` + `maximal-core`, its own entry files
  that compose the shell framework, and the maximal-specific renderer views +
  main-process wiring (spawn maximal-core via the shell's *generic* sidecar
  capability, bridge `/control` over the shell's IPC framework).

Why not the alternatives: making electron depend on a maximal plugin violates
"electron doesn't care about maximal"; a fork/template-sync reintroduces exactly
the "take every update" coupling the user is trying to kill. Model 1 is the only
fit.

### De-risking spike = the literal first step

Prove the seam small before extracting the whole shell:

1. In **electron**: add a minimal `exports` map exposing `./shared` (the IPC
   contract) + one renderer primitive + the preload bridge. Tag `v0.1.0`.
2. In **maximal**: scaffold a bare Electron app that deps on
   `github:stuffbucket/electron#v0.1.0` + `electron` + Forge, imports the shared
   contract + that primitive, and **boots a window**.
3. **Package it** (`electron-forge package`) and confirm it builds.
4. Success = a maximal-owned Electron window that renders a component imported
   from the versioned electron-shell dependency. That proves imports, versioning,
   and (critically) that Forge packaging survives the dependency boundary — before
   we invest in extracting terminal/agent/native modules or wiring maximal-core.

Once the seam holds, grow the exported surface and layer in maximal-core (via the
shell's generic sidecar capability) and the maximal feature UI.

## Still needed in parallel: clean the maximal repo

Independent of the electron work, and still wanted: **excavate `maximal/src`** (the
duplicated core) so maximal-core is the only engine source. Prerequisite: decouple
`feed-types` — the Tauri shell still imports `ActiveApiClient`/`InlineUiState`/
`ViewState` from `../../../src/lib/ws/feed-types` in 6 sites. Since Tauri is now
frozen (not developed), this can be as simple as leaving the parked branch alone
and removing root `src/` from the go-forward line. (Decide with D1 below.)

## Decisions for you

- **D-model — the packaging model.** Confirm Model 1 (electron publishes a
  reusable shell library; maximal owns its Forge app). This is the big commitment
  — it's a real refactor of the public electron repo into a library surface.
- **D-loc — where the maximal client lives.** A new dir in the maximal repo
  (`client/`), a fresh `maximal-app` repo, or replacing `maximal/shell`?
  Recommendation: a new `client/` in maximal, leaving the frozen Tauri `shell/`
  until excavation retires it.
- **D-pkg — one shell package or subpath exports.** Recommendation: one package
  `@stuffbucket/electron-shell` (the repo itself) with subpath exports
  (`/main`, `/preload`, `/renderer`, `/shared`, `/build`) — mirrors maximal-core.
- **D1 — maximal repo fate after excavation** (unchanged from prior draft):
  becomes the maximal-client + (frozen) Tauri shell repo.

## Recommended immediate next step

Confirm **D-model** (and ideally D-loc/D-pkg). Then execute the **de-risking
spike** above — the smallest thing that proves the build-dependency wiring — before
committing to the full shell-library extraction or any maximal-core wiring.
