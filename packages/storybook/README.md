# maximal Storybook

A catalog of every Settings and Dashboard UI piece, in every state, with no
running proxy. Lives in its own package (own pnpm lockfile, toolchain from the
root `mise.toml`) so Storybook's dependencies never touch the root Bun tree.

```sh
bun run storybook:install   # once (or after the lockfile changes)
bun run storybook           # dev server on :6006, restages on save
bun run storybook:build     # static build → packages/storybook/storybook-static
bun run storybook:check     # fixtures vs. API schemas + stories vs. component props
```

CI runs `storybook:check` on every push and PR. Run it locally after
changing a component's props or a `settings-types` schema. It runs
`scripts/ui-harness.ts --check` (every fixture against the real Zod schemas)
and this package's `tsc` (which follows story imports into `shell/src`, so a
story passing a stale prop shape fails). It doesn't render stories; open
Storybook for that.

## What's in it

| Sidebar | What it renders | Data |
|---|---|---|
| **Foundations / Tokens** | Every token in `shell/src/ui/styles/tokens.css`, read live, with computed values for the current theme | — |
| **Components / …** | `shell/src/ui/components/*` (Button, Switch, Checkbox, ConfirmDialog, Stack, Table) | props |
| **Settings / …** | The React islands — Apps, MCP servers, API clients, Models — as individual cards *and* as whole panels | props, or the mock sidecar |
| **Windows / Settings, Dashboard** | The real built windows in an iframe at their Tauri default size, any section × scenario | the mock sidecar |

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
