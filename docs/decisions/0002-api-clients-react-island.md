---
id: ADR-0002
title: Settings → API clients as a React island
status: proposed
date: 2026-05-19
authors:
  - stuffbucket
supersedes: []
links:
  design_context: .design-context.md
  settings_prd: docs/settings-window-prd.md
  api_routes: src/routes/settings/api-keys.ts
  api_types: src/lib/settings-types.ts
related_files:
  shell/index.html: host markup with the section header + mount point
  shell/src/main.ts: vanilla entrypoint that calls mountApiClients() once
  shell/vite.config.ts: registers @vitejs/plugin-react (after code-inspector-plugin)
  shell/tsconfig.json: jsx: "react-jsx"
  shell/package.json: react/react-dom/@types/* / @vitejs/plugin-react
---

# API clients as a React island

## Context

The Tauri shell ships a Settings window written in vanilla TS + plain
HTML. Four sections — Account, API clients, Logs, Diagnostics —
all wire up by querying static markup in `shell/index.html` and
attaching listeners from `shell/src/main.ts` and a tiny per-section
helper (`api-keys.ts`, etc.).

Two pressures pushed this section past what vanilla DOM
manipulation can hold:

1. **UX complexity.** The new spec (see "Behavior" below) is a
   table with: a pinned non-deletable wildcard row; an always-empty
   blank row that becomes a multi-field tab-cycle on focus; a
   "Select keys" mode toggle that shows/hides a checkbox column and
   conditionally surfaces a Delete button; a batch-delete flow with
   row highlighting; and an automatic reset on hash-nav-away.
2. **The vanilla module was already brittle.** `shell/src/api-keys.ts`
   had grown a handful of mutually entangled `data-*` selectors, a
   create-form-then-table empty-state dance, and an error display
   that leaked raw JSON envelopes. The Apple-Settings pattern the
   product wants would multiply the entanglement.

`.design-context.md` argues for a coherent design system, not a
framework. But the section-level complexity above genuinely benefits
from local state, scoped effects, and component composition. The
choice was to keep most of the shell vanilla and introduce React
**for this section only**, as an island mounted into the existing
section host.

The user explicitly directed: "Use good React practices and organize
your work properly… Vendor in controls for proper reuse." That rules
out a CSS framework like Tailwind/shadcn (this app's design system is
bespoke CSS tokens in `shell/src/tokens.css`) and rules out leaving
the section as vanilla. The right move is React + small first-party
primitives that wrap native HTML and consume the existing token CSS.

## Decision

1. Adopt **React as an island** in the Settings window. Only the
   API-clients section mounts React. Account, Logs, and Diagnostics
   stay vanilla — they're simpler and the vanilla path works.
2. **Vendored primitives** live under `shell/src/ui/`. Small TSX
   files that wrap native elements and apply existing `.btn`,
   `.switch`, `.input`, `.kbd`, `.table` CSS classes. No
   `class-variance-authority`, no `clsx`, no `tailwind-merge`, no
   shadcn — a 4-line local `cx()` helper is sufficient.
3. **Feature folder** at `shell/src/features/api-clients/` for the
   composition layer (root component, row components, data hook,
   error humanizer). One concern per file.
4. **Mount point** is a single `<div id="api-clients-root"></div>`
   nested *inside* `<section data-section="api-clients">`. The
   section header (`<h2>` + section subtitle) stays in HTML — React
   owns the content body only. The vanilla `showSection()` in
   `main.ts` continues to toggle `[hidden]` on the section, so
   hash-nav routing keeps working without React Router.
5. **Hash-nav scoped state.** The React component listens for
   `hashchange` and, on leaving `#api-clients`, resets
   `selectMode = false` and clears any row selection. Returning to
   the section starts in default state. No persistence of the
   "Select keys" toggle.
6. **No new build infrastructure beyond `@vitejs/plugin-react`.**
   The Vite plugin pipeline already registers
   `code-inspector-plugin` (Shift+Opt hover → VS Code) which must
   come before `@vitejs/plugin-react`; respect that ordering.

## Behavior — full spec

The table has four columns: **Select / API Key / Purpose / Enabled**.

### Rows, top to bottom

1. **Wildcard row** (always first, always present):
   - API Key: `*`
   - Purpose: `Allow all API keys`
   - Enabled: toggleable; defaults `on` if no wildcard entry exists
     in config, otherwise reflects current state.
   - Cannot be deleted. In Select-keys mode the row's Select
     checkbox renders **disabled** (visually `⊘`).
   - Toggling Enabled from off→on with no wildcard entry yet should
     POST `{label:"Allow all", key:"*"}`. Toggling it off (when the
     entry exists) should PATCH `enabled:false`. The user must never
     end up with the wildcard row absent — only enabled or disabled.
2. **User-created keys**, in stable list order. Each row:
   - API Key: masked display (`•••••••`), click to copy real value.
     A `Show / Hide` ghost button toggles the mask.
   - Purpose: click-to-edit text. Enter commits via PATCH, Esc
     reverts, blur commits.
   - Enabled: checkbox; PATCHes on change.
   - In Select-keys mode: leading checkbox; selecting highlights
     the row with `.api-keys__row--selected` (subtle surface tint).
3. **Blank row** (always last):
   - Two inline inputs and a checkbox: `API Key` (placeholder
     `Auto-generate`), `Purpose` (placeholder `What is this for?`),
     `Enabled` (defaults checked).
   - Tab cycles API Key → Purpose → Enabled. Tabbing PAST Enabled
     commits the row (POST `/settings/api/api-keys`) and spawns a
     fresh blank row below with focus moved to its API Key field.
   - Enter at any field also commits.
   - Esc clears the in-progress inputs without committing.
   - The implementation can re-render the blank row by bumping a
     `newRowKey` counter on the parent component (component-keyed
     remount) to reset state cleanly.

### Toolbar (bottom-right, inside the data-table chrome)

- Default: a single `Select keys` switch on the right.
- When the switch is ON: the Select column becomes visible.
- When ≥1 user-created row is selected: a `Delete (n)` destructive
  button appears **to the left** of the switch, showing the count.
  Clicking it confirms (native `window.confirm`) and fans out N
  sequential `DELETE /settings/api/api-keys/:id` calls. After the
  last DELETE, reload the list.
- The wildcard row's checkbox is disabled, so it can never be in
  the selection set.

### Hash-nav reset

Wire a `hashchange` listener that, when the new hash is not
`#api-clients`, calls `setSelectMode(false)` and clears the
selection set. Returning to the section therefore starts clean.

### Errors

The proxy returns `{error: {message, type}}` JSON on failure. The
component must humanize this — surface only `message` (or the raw
string if it's not JSON) — and render in a
`.state__caption.state__caption--error` paragraph above the table.
**Never display the raw envelope.** A `humanize.ts` helper at
`shell/src/features/api-clients/humanize.ts` owns this.

## Required file inventory

The agent picking this up must reconstruct the following set. Names
and locations are normative; signatures inside are suggestions.

```
shell/src/ui/
  cx.ts                # ~4-line classname joiner
  Button.tsx           # variants: primary | secondary | ghost | destructive; sizes: md | sm
  Switch.tsx           # controlled toggle: { checked, onCheckedChange, label }
  Checkbox.tsx         # controlled native <input type="checkbox"> w/ disabled support
  Table.tsx            # exports Table, Thead, Tbody, Tr, Th, Td
  TextInput.tsx        # borderless inline-edit; forwardRef for focus management
  (no further primitives unless the work demands it)

shell/src/features/api-clients/
  ApiClients.tsx       # root: owns selectMode, selectedIds, newRowKey, localError
  useApiKeys.ts        # hook over apiCall(): { entries, enforcing, isLoading, error, reload, create, update, remove }
  WildcardRow.tsx      # pinned `*` row; reflects/creates wildcard entry on toggle
  KeyRow.tsx           # masked key + click-to-copy + Show/Hide + Select checkbox + Enabled toggle + Purpose inline-edit
  NewKeyRow.tsx        # always-present blank row; remounts via key after commit
  Toolbar.tsx          # Delete (n) (visible only when selectMode && selectedCount > 0) + Select keys switch
  humanize.ts          # extract human message from {error: {message, type}} envelopes

shell/src/api-clients-island.tsx
  # createRoot(host).render(<ApiClients/>); exports mountApiClients()

shell/index.html
  # The <section data-section="api-clients"> body collapses to
  # <header class="section__head">...</header><div id="api-clients-root"></div>

shell/src/main.ts
  # Replace any call to wireApiKeys() with mountApiClients();
  # remove ./api-keys.ts import; mountApiClients runs once at DOMContentLoaded.

shell/src/api-keys.ts
  # DELETED — fully replaced by the React feature.
```

CSS additions go in `shell/src/styles.css` (NOT a CSS module): new
classes `.api-keys__row--selected`, `.api-keys__row--wildcard`,
`.api-keys__row--new`, `.api-keys__select-col`,
`.api-keys__select-col--hidden`, `.api-keys__inline-input`,
`.api-keys__key-text--copied`, `.api-keys__delete-btn`. Every new
value must reference a token (`var(--space-3)`, `var(--surface-control)`,
etc.) — no raw px or hex.

## Constraints (non-negotiable)

- **No Tailwind, no shadcn, no Radix.** The shell uses bespoke CSS
  tokens; introducing a CSS framework would fork the design system.
- **Don't touch Account, Logs, Diagnostics.** They stay vanilla. The
  vanilla `showSection()` in `main.ts` continues to drive
  `[hidden]` on each `<section>`.
- **No new runtime deps** beyond `react`, `react-dom`, `@types/react`,
  `@types/react-dom`, `@vitejs/plugin-react`.
- **Vite plugin order** must be `[codeInspectorPlugin(), react(), …]`
  in `serve` mode; the inspector plugin asks to come before the
  React transformer.
- **`code-inspector-plugin` JSX support.** The plugin stamps
  `data-insp-path` on JSX nodes when it runs after the React JSX
  transform. The custom `htmlSourcemap` plugin in `vite.config.ts`
  (which stamps attributes on the static `index.html`) handles the
  vanilla side; both should coexist without conflict.
- **No batch-delete endpoint.** `DELETE /settings/api/api-keys/:id`
  is the only delete API. The Toolbar runs N sequential DELETEs.
  If this becomes a hot path (>10 keys deleted at once is unlikely
  in practice), a `POST /settings/api/api-keys/bulk-delete` is the
  natural extension; out of scope for this ADR.

## Integration steps for the agent picking this up

The previous attempt landed all the files in the working tree but
they were lost to a concurrent process. Reconstruct as follows:

1. **Look first** at `.claude/worktrees/agent-a9f7aac74f86d459a/` if
   it still exists — that worktree was on branch
   `worktree-agent-a9f7aac74f86d459a` and the prior agent's report
   asserts the files were created there, even though the file-cwd
   resolution wrote into the parent at the time. The branch may
   have a snapshot worth diffing against.
2. **Install React deps** in `shell/`:
   `bun add react react-dom && bun add -d @types/react @types/react-dom @vitejs/plugin-react`.
3. **Update `shell/tsconfig.json`**: add `"jsx": "react-jsx"`.
4. **Update `shell/vite.config.ts`**: import
   `react from "@vitejs/plugin-react"`, register it in both serve
   and build pipelines, AFTER `codeInspectorPlugin()` in serve mode.
5. **Reconstruct the file tree** under the "Required file inventory"
   section above. Each file should be small (the primitives are
   under 60 lines; the feature components 30–120 lines each).
6. **Edit `shell/index.html`**: inside
   `<section class="section" data-section="api-clients">`, keep
   `<header class="section__head">…</header>` and replace the rest
   with `<div id="api-clients-root"></div>`.
7. **Edit `shell/src/main.ts`**: replace `wireApiKeys()` with
   `mountApiClients()`, remove the `./api-keys.ts` import. Delete
   `shell/src/api-keys.ts`.
8. **Run checks** from repo root:
   - `bun run typecheck` — must be clean
   - `cd shell && bunx tsc --noEmit` — must be clean
   - `bun test` — `tests/account-section.test.ts` reads `shell/index.html`;
     make sure your edits don't break unrelated assertions
   - `cd shell && bun run dev` — page should boot and render

## Open questions for the integrating agent

- **Wildcard "default Enabled" semantics.** When the wildcard entry
  doesn't exist in config, should the row visually render as
  Enabled (`[x]`) and lazily POST on first off-toggle? Or render as
  Disabled (`[ ]`) and POST `{enabled:true}` on first on-toggle?
  The spec text says "Enabled: defaults `[x]`", which argues for the
  former. The previous agent's report flagged this as an ambiguity;
  pick the lazier creation path (render `[x]` by default; POST only
  on intentional change) and document the choice in a code comment.
- **Inline label editing vs popover.** The Purpose cell is
  click-to-edit. Sufficient, or should it open a small popover?
  Inline is simpler and matches Apple System Settings; keep that
  unless usability testing surfaces a problem.
- **Show / Hide for wildcard key.** The wildcard key (`*`) is one
  character; there's nothing to mask. The Show/Hide button on that
  row should render disabled (`—` or hidden). Match the previous
  agent's choice unless you have a better idea.
- **Concurrent edits.** This codebase has had multiple agents
  editing the same files (this ADR exists *because* of that). The
  integrating agent should commit their reconstruction in a clean
  worktree and surface the commit SHA in their report — don't
  trust the working tree to stay stable mid-flight.

## What this ADR explicitly does NOT cover

- **Migration of Account / Logs / Diagnostics to React.** Out of
  scope. If those sections later outgrow vanilla, write a new ADR;
  don't extend this one.
- **Routing.** Hash-based section toggling stays in
  `shell/src/main.ts`; React doesn't own routing.
- **Batch-delete endpoint.** N sequential DELETEs is fine for v1.
- **Storybook / Ladle / Playwright design loops.** The companion
  doc `docs/design-stack-vite-playwright.md` is currently
  aspirational ("not implemented"). Stay vanilla on testing for
  this section; rely on `bun test` integration tests that grep
  `index.html`.

## Status of the work as of 2026-05-19

The first attempt to land this work produced the file tree above
(verified by both `find` and the prior agent's report). A concurrent
process — origin unknown, possibly another background agent —
deleted the React feature tree from the parent checkout shortly
after. `shell/src/main.ts` still references
`mountApiClients` and `mountQuitConfirm` (the latter is unrelated
work from a different concurrent agent that also didn't land), so
the shell currently fails `bunx tsc --noEmit`.

This ADR captures the intent + spec + integration steps so the next
agent (or human) doesn't have to reconstruct from conversation
transcripts. When the React island is re-landed cleanly, flip
`status: proposed` → `status: accepted` and add the merging
commit SHA to the `links:` block.
