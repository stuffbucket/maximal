# maximal Storybook

A catalog of every Settings and Dashboard UI piece, in every state, with no
running proxy. Lives in its own package (own pnpm lockfile, toolchain from the
root `mise.toml`) so Storybook's dependencies never touch the root Bun tree.

```sh
bun run storybook:install   # once (or after the lockfile changes)
bun run storybook           # dev server on :6006, rebuilds and refreshes on save
bun run storybook:assets    # export stories tagged `asset` to dist/storybook-assets
bun run storybook:build     # static build → packages/storybook/storybook-static
bun run storybook:check     # fixtures vs. API schemas + stories vs. component props
```

CI runs `storybook:check` on every push and PR. Run it locally after
changing a component's props or a `settings-types` schema. It runs
`scripts/ui-harness.ts --check` (every fixture against the real Zod schemas)
and this package's `tsc` (which follows story imports into `shell/src`, so a
story passing a stale prop shape fails). It doesn't render stories; open
Storybook for that.

## Exporting assets

`bun run storybook:assets` builds a static Storybook and exports stories tagged
`asset` in both light and dark modes. A story whose visible output is one
standalone SVG becomes a portable SVG with its computed presentation styles
inlined. Everything else becomes a tightly cropped WebP; `--format png` keeps a
lossless raster instead. Output and a machine-readable `manifest.json` go to
`dist/storybook-assets/`; that generated directory is replaced on each default
run so removed or renamed stories cannot leave stale assets behind.

```sh
# The tagged connector glyph set (the default)
bun run storybook:assets

# One arbitrary story, exported as a PNG
bun run storybook:assets -- components-button--primary --format png

# Reuse an already running Storybook and choose stories by id glob
bun run storybook:assets -- --url http://127.0.0.1:6006 --match 'settings-*'

# Export the selected engagement-funnel journeys only
bun run storybook:assets -- --tag journey

# Discover ids and override crop/appearance when needed
bun run storybook:assets -- --list
bun run storybook:assets -- components-button--primary --selector button --theme dark
```

The exporter defaults to both themes, English, a 2× raster scale and a small
crop margin. Pass one `--theme` to generate only that variant; repeat it to
choose an explicit matrix. Filenames include theme (and non-English locale) so
variants do not overwrite each other. The manifest records each story's tags,
fixture scenario and rendered theme. Use `--help` for selection, viewport,
scale and crop options.

Each story is exported only after Storybook reports it finished (render, `play`
function and `afterEach`), so a play function that opens a modal or detail pane
has completed first. A play, render or missing-story error fails the export with
that story's id; nothing is written for it. The exporter then waits for fonts,
images and nested frames, for any `aria-busy="true"` element to clear, and for
the layout to hold still for three frames (30 s per-story timeout).

Raster crop rules, so output does not depend on viewport luck:

- `--selector` crops exactly that element.
- Otherwise, if the story has open dialogs, the crop is the last open modal
  dialog in document order (else the last open non-modal dialog). A modal lives
  in the browser's top layer, so the story root keeps the size of the page
  behind it and would otherwise produce a thin crop of the background.
- Otherwise the crop is the union of the story root's visible children.
- `--padding` is then added, clamped to the page edges (the origin at 0 and the
  scrollable page extent; the target itself is never cut), and the box is
  snapped outward to whole CSS pixels. Output pixels are CSS size × `--scale`
  for both WebP and PNG, matching `pixelScale` in the manifest.

Asset stories run through the normal Storybook preview, so `parameters.mockApi`
and window-story `scenario` args use the same validated fixtures as UI Preview
and `bun run ui:harness`. Tag only deliberately reusable, deterministic stories
with `asset`; interactive stories should first be reduced to a deterministic
fixture and play state.

The default set includes connector glyphs, the FigJam plugin panel, and these
representative engagement-funnel journeys:

| Funnel step | Story | Fixture |
|---|---|---|
| Onboarding | Settings account signed out | `signed-out` |
| Activation | Settings account signed in | `signed-in` |
| Configuration | Fresh install app selection | `fresh-install` |
| Integration | Ready connector detail | `connectors-detail-ready` |
| First value | Dashboard live traffic | `live-sessions` |
| Engagement | Live sessions | `live-sessions` |
| Retention | Rules limits and activity | `budget-limits` |

Every row carries `asset`, `journey`, and a `funnel-*` tag, so downstream jobs
can export all assets or only the funnel subset without maintaining a second
list.

## What's in it

| Sidebar | What it renders | Data |
|---|---|---|
| **Foundations / Tokens** | Every token in `shell/src/ui/styles/tokens.css`, read live, with computed values for the current theme | — |
| **Components / …** | `shell/src/ui/components/*` (Button, Switch, Checkbox, ConfirmDialog, Stack, Table) | props |
| **Settings / …** | The React islands — Apps, API clients, Models — as individual cards *and* as whole panels | props, or the mock sidecar |
| **Rules / Rules** | The Rules surface (summary, Rules, Activity, Settings) and its add, edit and delete dialogs, against the mock budget service | the mock sidecar |
| **FigJam / Plugin Panel** | The real Figma plugin panel: ready, selection, conversation, settings and bridge-approval states | deterministic Figma, model and bridge messages |
| **Windows / Settings, Dashboard, Rules** | The real built windows in an iframe at their Tauri default size, any section × scenario | the mock sidecar |

The toolbar's **Theme** sets `data-theme` the way the app does; **Locale**
applies to the window stories (the React islands aren't localized yet).

## How the data works

There's one mock sidecar: `scripts/ui-harness-api.ts`, a pure
`Request → Response` function over the fixtures in
`scripts/ui-harness-fixtures.ts`. `bun run ui:harness` serves it over HTTP;
this package installs it in the browser by replacing `fetch` and
`EventSource` for the UI's backend paths (`src/mock/fetch-mock.ts`). The
harness validates every fixture against the real Zod schemas at startup, so
a schema change that the fixtures miss fails there loudly.

- **Island stories** pick a fixture with `parameters.mockApi`:

  ```ts
  parameters: {
    mockApi: {
      scenario: "apps-conflict",                       // a SCENARIOS id
      latencyMs: 800,                                  // make transitions visible
      overrides: {                                     // per-pathname replies
        "/settings/api/models": "hang",                // stay loading
        "/settings/api/apps": { status: 500, body: { error: { message: "…" } } },
      },
    },
  }
  ```

- **Window stories** load `ui/<surface>/index.html?scenario=…&theme=…&locale=…#section`.
  `scripts/prepare-ui.ts` runs the repo's own `build:ui`, copies
  `shell/dist/ui` to `.ui/`, and injects `src/mock/window-bootstrap.ts` as
  each page's first script. Nothing else in the shipped pages changes.

## Adding things

- **A new component or island**: add `src/<area>/<Name>.stories.tsx` next
  to its siblings. Import the component straight from `shell/src`. Cover each
  visual state, not just the happy path.
- **A new backend state**: add a scenario to `scripts/ui-harness-fixtures.ts`.
  It shows up in every window story's scenario control and in `ui:harness`.
- **A new endpoint**: handle it in `scripts/ui-harness-api.ts` (and add a
  schema check in `scripts/ui-harness.ts` if it has a Zod schema).
