# Design stack — Vite, Chromium, Playwright

A concrete stack proposal that implements `docs/design-feedback-loops-practices.md` (L1–L5). The companion doc names the *what* and the *latency budgets*; this doc names the *packages*, the *configs*, and the *workflow*. Read both. Where the loops doc and this doc disagree, the loops doc wins.

This doc is opinionated. Every recommendation is a choice, not a survey. The "tools considered and rejected" notes are inline so the next reader doesn't relitigate.

## TL;DR

| Layer | Tool |
|---|---|
| Framework | **React 19** + TypeScript |
| Bundler | **Vite 7** (8 once plugin ecosystem catches up; Rolldown is still settling) |
| CSS strategy | **Plain CSS + custom properties** authored in `tokens.css`; no Tailwind, no UnoCSS |
| Token authoring | Hand-curated `tokens.css`; **style-dictionary** held in reserve |
| Component sandbox | **Ladle** |
| L1 lint | **stylelint** + `stylelint-declaration-strict-value`, **eslint-plugin-jsx-a11y**, custom AST passes |
| L3 a11y | **@axe-core/playwright** in container |
| L4 visual regression | **Playwright snapshots** (`toHaveScreenshot`) in container |
| Component a11y primitives | **react-aria-components** |
| Dev-time a11y | **@axe-core/react** injected by a tiny Vite plugin |
| Runtime perf | `page.metrics()` + `performance.getEntriesByType('paint')` via Playwright |
| State | **Jotai** (small atoms) for shared theme + token state |
| Help/docs surface | **MDX via @mdx-js/rollup** |

## 1. Framework — React 19

The shell is currently vanilla TS + Vite + Tauri. Three small windows (Setup ~520×620, Dashboard ~960×720, Settings ~880×720). The honest case for *staying* vanilla is real: minimal runtime, simple bundles, no JSX runtime overhead, no React Server Components confusion in a local app.

Recommend **React 19** anyway. Reasons, in order of weight:

1. **The design-feedback-loops doc leans on tools that exist primarily in React.** `react-aria-components`, `@axe-core/react`, React DevTools' component inspector, `why-did-you-render`, error boundaries with named owners — every one of these is the React-flavored version of something that has no equivalent in vanilla TS without writing it yourself. The doc explicitly asked for "React tools."
2. **Iterative design needs cheap reconciliation.** When a designer toggles a token in the in-app inspector (section 6), every visible card recomputes. With vanilla TS you wire that by hand. With React it's a context value change and the tree re-renders. The cost of the abstraction is the cost of the runtime; the benefit is one source of truth for "what does the UI look like right now."
3. **A11y primitives.** `react-aria-components` ships focus, keyboard, and screen-reader behavior for menus, dialogs, listboxes, comboboxes, switches, sliders, and date inputs. Building those by hand in vanilla DOM is months of work and the result is worse. (See `react-aria-components` v1.17+, Adobe, active in 2026.)
4. **Storybook / Ladle expect a component-tree framework.** Vanilla stories exist but the ecosystem is React-first.

Honest counter-cases considered and rejected:

- **Preact** — Same API, ~3KB. Rejected because `react-aria-components` and `@axe-core/react` advertise React compatibility, not Preact. The aliased `preact/compat` layer mostly works, but "mostly" is the wrong posture for accessibility primitives.
- **Solid** — Cleaner reactivity model, faster on benchmarks. Rejected because the headless a11y story is `kobalte` (good but smaller community) and DevTools are weaker. The win on per-render speed is invisible in a three-window app.
- **Svelte** — Same as Solid; better DX for many, but the design-tools ecosystem (`@axe-core/react`, `why-did-you-render`, React DevTools) doesn't translate.
- **Stay vanilla** — Defensible only if the windows stop growing. Given that Settings already has eight sections and the design context calls out a future command palette, the windows *will* grow.

**Server components / RSC are explicitly out.** This is a local Tauri webview pointing at a local dev server. There is no server. The React 19 features used are hooks, `useTransition`, `Suspense` for code-split sections, and error boundaries.

## 2. Vite configuration for design-first iteration

Vite 7 is the current shipping target. Vite 8 (Rolldown bundler) is stable as of March 2026 but several plugins in this stack — Ladle, MDX, `vite-plugin-pwa`-adjacent things — still trail. Move to 8 the quarter after Ladle ships a Vite-8-tested release. Until then, Vite 7.3.

The shell needs three things from Vite that the current minimal config doesn't deliver:

1. CSS HMR that updates `:root` custom properties without a full reload.
2. A dev-only `@axe-core/react` injection so the console reports a11y issues live.
3. Aliased imports so files read cleanly: `@components`, `@tokens`, `@hooks`, `@pages`.

```ts
// shell/vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import mdx from "@mdx-js/rollup";
import { resolve } from "node:path";

const host = process.env.TAURI_DEV_HOST;
const isDev = process.env.NODE_ENV !== "production";

export default defineConfig({
  plugins: [
    { enforce: "pre", ...mdx({ providerImportSource: "@mdx-js/react" }) },
    react({
      // Fast Refresh is on by default; this opts the design context out of it
      // so a token edit re-renders every consumer cleanly.
      include: /\.(mdx|js|jsx|ts|tsx)$/,
    }),
    isDev && axeDevPlugin(),
  ].filter(Boolean),

  resolve: {
    alias: {
      "@components": resolve(__dirname, "src/components"),
      "@tokens": resolve(__dirname, "src/tokens"),
      "@hooks": resolve(__dirname, "src/hooks"),
      "@pages": resolve(__dirname, "src/pages"),
    },
  },

  css: {
    devSourcemap: true,
    // Lightning CSS for transforms; cheaper than PostCSS for the few things we
    // need (nesting, custom-media). Falls back gracefully on unknown syntax.
    transformer: "lightningcss",
    lightningcss: {
      drafts: { customMedia: true },
      targets: { chrome: 120 }, // Tauri webview floor — adjust to your shell.
    },
  },

  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },

  build: {
    sourcemap: true, // designers debug production occasionally; the cost is bytes, not seconds.
    target: "chrome120",
  },
});

// Tiny in-tree plugin: inject @axe-core/react in dev only.
function axeDevPlugin() {
  return {
    name: "axe-dev-inject",
    transformIndexHtml(html: string) {
      return html.replace(
        "</head>",
        `<script type="module">
           import('@axe-core/react').then(({ default: axe }) =>
             import('react-dom/client').then(({ }) =>
               import('react').then(React => axe(React, window, 1000))));
         </script></head>`,
      );
    },
  };
}
```

What's deliberately *not* in the config:

- No PostCSS pipeline. Lightning CSS handles nesting and custom-media; nothing else is needed when you don't use Tailwind. If you ever do, swap `transformer: "lightningcss"` for the default PostCSS chain.
- No `vite-plugin-checker`. The L1 hook already runs `tsc` and `stylelint`; running them again in the Vite overlay duplicates signal and inflates the dev-server start time.

### CSS strategy — plain CSS + custom properties

Pick one and live with it. The choices:

| Approach | Verdict |
|---|---|
| **Plain CSS + custom properties** | **Pick this.** Tokens are already CSS custom properties (see `.design-context.md`). The L1 token enforcement rule (`stylelint-declaration-strict-value`) targets raw values; it's a perfect fit. Zero build step beyond Lightning CSS. |
| **CSS Modules** | Compatible with above; good for component-scoped class names. Adopt as the default `*.module.css` pattern *on top of* plain CSS for tokens. |
| **Tailwind v4** | Tailwind v4's CSS-first `@theme` directive is closer to plain CSS than v3 was. Still a layer of indirection that fights the token-enforcement story (`p-4` is a utility class, not a `var(--space-4)` reference). The stylelint rule can't see what `p-4` resolves to. Reject. |
| **UnoCSS** | Faster than Tailwind, same problem. Reject. |
| **CSS-in-JS** (Emotion, styled-components) | Runtime overhead, less HMR fidelity for token-only edits, fights the static-analysis story. Reject. |

The result: each component ships `MyThing.module.css` for scoped layout/positioning class names, and references `var(--space-*)`, `var(--text-*)`, `var(--surface-*)` for every concrete value. `tokens.css` is imported once at app entry.

### HMR for tokens

CSS imported as a side-effect (`import './tokens.css'` at app entry) is HMR'd by Vite without a full reload. A `--space-*` edit propagates in ~50ms. The reason: Vite invalidates the CSS module and re-injects it; the browser recomputes styles. Components don't re-mount, focus survives, scroll position survives. This is the load-bearing affordance for the iterative-tweaking workflow.

What breaks this: importing tokens inside a `*.module.css` (Vite treats it as a different graph node) or wrapping tokens in `<style>` injected via JS. Don't.

## 3. Component sandbox — Ladle

Compared:

| Tool | Cold start | Vite-native | A11y addon | VRT integration |
|---|---|---|---|---|
| **Storybook 8/10** | ~8s | Yes (Vite builder) | `@storybook/addon-a11y` | Chromatic, Lost Pixel |
| **Ladle** | ~1.2s | Native | None first-party | Pair with Playwright |
| **Histoire** | ~2s | Native | None | Pair with Playwright |

Ladle wins on cold start by 6.7×, hot reload by 4×, and it's React-only — fine, we're React-only. The cost: no Storybook ecosystem, no first-party a11y panel, no addons.

The cost is acceptable because the L3/L4 split in `design-feedback-loops-practices.md` already moves a11y and visual regression to Playwright in a container. We don't need the Storybook a11y addon — we have `@axe-core/playwright`. We don't need Chromatic — we have Playwright snapshots.

If the project ever grows to "real" component documentation (public-facing docs, MDX-heavy reference pages, hundreds of stories), reconsider Storybook. Until then, Ladle's speed is the bigger feedback-loop win.

```js
// .ladle/config.mjs
export default {
  stories: "src/**/*.stories.{ts,tsx}",
  defaultStory: "welcome",
  addons: {
    theme: { enabled: true, defaultState: "auto" }, // light/dark toggle in toolbar
    a11y:  { enabled: true },                        // basic axe pass in dev panel
    rtl:   { enabled: false },                       // not yet
    width: {
      enabled: true,
      options: {
        setup: 520,
        dashboard: 960,
        settings: 880,
      },
      defaultState: 960,
    },
  },
};
```

The `width` addon doubles as window-size simulation: a story for `<SettingsPane />` rendered at 880px is a fair preview of the real window. Plug `tokens.css` into the Ladle root so a token edit propagates to every story.

```ts
// .ladle/components.tsx
import "../src/tokens/tokens.css";
import "../src/tokens/theme-light.css";
import "../src/tokens/theme-dark.css";
import type { GlobalProvider } from "@ladle/react";
import { ThemeProvider } from "../src/hooks/useTheme";

export const Provider: GlobalProvider = ({ children, globalState }) => (
  <ThemeProvider mode={globalState.theme}>{children}</ThemeProvider>
);
```

## 4. Chromium + Playwright integration

This is the headline ask. Playwright sits at L3 (a11y, semantic-tree, perf snapshots) and L4 (visual regression). Both run in a container; see section 9.

### Visual regression — Playwright `toHaveScreenshot`, not Lost Pixel

Choices considered:

- **Playwright `toHaveScreenshot()`** — Built in. Uses pixelmatch. Baselines are committed to the repo. No external service. Manual baseline updates via `--update-snapshots`.
- **Lost Pixel** — Open-source baseline storage + diff UI, Docker-based. Good if you run Storybook *and* full-page shots *and* want a managed diff UI. Overkill if you already commit to running Playwright in a container.
- **Percy / Chromatic / Applitools** — Paid. Third-party data flow. Out of bounds for a local-first tool.
- **reg-suit** — Assembly required; you bring the screenshot generator.

Pick **Playwright `toHaveScreenshot`**. The reason: we already need Playwright for a11y and perf. One container, one tool, one snapshot store on disk. Lost Pixel's win is its diff UI; Playwright's trace viewer (section below) covers the same need.

```ts
// tests/visual/windows.spec.ts
import { test, expect } from "@playwright/test";

const WINDOWS = [
  { name: "setup",     url: "http://host.docker.internal:1420/setup",     width: 520, height: 620 },
  { name: "dashboard", url: "http://host.docker.internal:1420/dashboard", width: 960, height: 720 },
  { name: "settings", url: "http://host.docker.internal:1420/settings",  width: 880, height: 720 },
] as const;

const THEMES = ["light", "dark"] as const;
const ACCENTS = ["#c8334a", "#3b82f6", "#10b981"] as const; // brand default + two user picks

for (const w of WINDOWS) {
  for (const theme of THEMES) {
    for (const accent of ACCENTS) {
      test(`${w.name} • ${theme} • ${accent}`, async ({ page }) => {
        await page.setViewportSize({ width: w.width, height: w.height });
        await page.goto(`${w.url}?theme=${theme}&accent=${encodeURIComponent(accent)}`);
        await page.waitForFunction(() => document.fonts.ready);
        await expect(page).toHaveScreenshot(`${w.name}-${theme}-${accent.slice(1)}.png`, {
          maxDiffPixelRatio: 0.01,
        });
      });
    }
  }
}
```

`maxDiffPixelRatio: 0.01` (1%) absorbs subpixel font noise. If a real change exceeds it, the failure has a side-by-side diff in `playwright-report/`.

### Interactive inspection — `--ui`, `codegen`, `pause()`

A designer uses Playwright as a spelunker, not (only) as a CI tool.

- **`playwright codegen http://localhost:1420/settings`** opens a recorder window. Click around, copy out a selector. Useful for "what's the right way to assert on this control."
- **`playwright test --ui`** opens a watch UI: pick a test, step through actions, see snapshots per action, edit the test live. The L4 trace viewer (below), but for the live run.
- **`await page.pause();`** inside a test, run with `--headed`, drops the designer into a paused Chromium with DevTools open. Live-edit styles, then resume.

### Headless vs headed

- **Headed during iteration.** You can see what the test sees; you can pause and inspect.
- **Headless for CI and for the L4 baseline run.** Faster, deterministic, no cursor flicker in snapshots.

The container runs headless by default. Iteration runs headed on the host (against the same dev server), and only the baseline-generation step runs through the container.

### Trace viewer

`page.context().tracing.start({ snapshots: true, screenshots: true, sources: true })` at the start of a test, `stop({ path: 'trace.zip' })` at the end. Open with `playwright show-trace trace.zip` or drop on https://trace.playwright.dev. The viewer shows screenshots, DOM snapshots, network, console, and a timeline — one tool for "what was the page actually doing at the moment this assertion failed."

For design iteration: capture a trace of a "what does the focus flow look like across this form" walkthrough, share the `.zip`. Lighter weight than a screen recording, navigable.

### Accessibility tree snapshots

```ts
test("settings has expected aria structure", async ({ page }) => {
  await page.goto("http://host.docker.internal:1420/settings");
  await expect(page.locator("body")).toMatchAriaSnapshot(`
    - banner:
      - heading "Settings" [level=1]
    - navigation:
      - link "General"
      - link "Account"
      - link "API clients"
    - main:
      - heading "General" [level=2]
  `);
});
```

`toMatchAriaSnapshot` (Playwright 1.49+) catches the cases where a screen reader sees a different page than a sighted user does. The snapshot is YAML, committed, reviewable.

### Performance snapshots

```ts
const metrics = await page.evaluate(() => ({
  fcp: performance.getEntriesByType("paint").find(e => e.name === "first-contentful-paint")?.startTime,
  lcp: performance.getEntriesByType("largest-contentful-paint").at(-1)?.startTime,
  nodes: document.querySelectorAll("*").length,
}));
expect(metrics.fcp).toBeLessThan(200);
expect(metrics.nodes).toBeLessThan(2000); // sanity ceiling; Settings sits around 600.
```

Per-window budgets live in the test. A regression that doubles the DOM size fails CI before it lands.

### Coverage API for unused CSS

```ts
await page.coverage.startCSSCoverage();
await page.goto(url);
const cov = await page.coverage.stopCSSCoverage();
const unused = cov.flatMap(e =>
  e.ranges.length === 0 ? [{ url: e.url, bytes: e.text.length }] : []
);
```

Run weekly, not per-edit. Surfaces token files imported but never read, dead utility rules, and bloat from copy-pasted component CSS.

## 5. React-specific tools

The full set, in install order:

| Package | Role | Layer |
|---|---|---|
| `react`, `react-dom` v19 | Runtime | n/a |
| `@vitejs/plugin-react` | Fast Refresh + JSX transform | n/a |
| `react-aria-components` | Headless a11y primitives (Menu, Dialog, ListBox, Switch, etc.) | runtime |
| `@axe-core/react` | Dev-only console a11y report | dev |
| `@welldone-software/why-did-you-render` | Wasted-render detector in dev | dev |
| `jotai` | Shared atoms for theme, accent, user tokens | runtime |
| `@mdx-js/rollup` + `@mdx-js/react` | MDX for help/about pages | build |
| `@axe-core/playwright` | Test-time a11y | L3 |

### React DevTools

What it gives a designer beyond Chrome DevTools alone:

- **Component tab.** Hover a card; the Elements panel highlights the DOM, the Components panel highlights the source. With "always show component locations" on, the source path appears inline — `SettingsPane > AccentPicker > ColorSwatch`.
- **Profiler.** Record an interaction; see which components re-rendered, why, and how long each took. Pairs with `why-did-you-render` for the "why."
- **State editing.** Tweak a state value from the panel and watch the UI update. The in-app design REPL (section 6) covers token tweaking; React DevTools covers per-component state tweaking.

### Why Did You Render

```ts
// src/wdyr.ts — imported once at top of src/main.tsx, dev only.
import React from "react";
if (process.env.NODE_ENV === "development") {
  const wdyr = (await import("@welldone-software/why-did-you-render")).default;
  wdyr(React, { trackAllPureComponents: true });
}
```

A noisy console at first; tune by adding `MyComponent.whyDidYouRender = false` to suppress known cases. Catches the "this card re-renders on every keystroke in an unrelated input" class of bug, which a designer feels as "the UI is laggy" without ever pinpointing it.

### @axe-core/react

Injected by the Vite plugin in section 2. Logs WCAG violations to the console with stack traces pointing at the offending DOM. Latency is ~1s per page load, dev-only, so the runtime cost is invisible. Pairs with the L3 Playwright run: dev catches the obvious, L3 catches the systematic.

### react-aria-components

The library Adobe maintains for headless accessible primitives. v1.17 (2026) is GA, actively maintained, dependencies recently consolidated. Use it for: Dialog (modals + confirmation prompts), Menu (tray menu mirroring, command palette stub), ListBox (Settings sidebar nav), Switch (theme toggle), ComboBox (the "Reveal in editor" path picker), and Slider (accent hue picker).

The alternative is hand-rolling each. Don't.

### Suspense + ErrorBoundary discipline

Every async data boundary in the windows gets a Suspense fallback that is *designed*, not just `Loading...`. The design-context's "Color is the user's, contrast is ours" extends to empty/loading/error states: each has a visual, copy, and a recovery action.

```tsx
<ErrorBoundary fallback={<SettingsErrorState />}>
  <Suspense fallback={<SettingsSkeleton />}>
    <SettingsPane />
  </Suspense>
</ErrorBoundary>
```

The skeleton is a real component with real tokens, not a spinner. The error state names the failure ("We can't reach the proxy") and offers a button ("Restart sidecar"). Both are stories in Ladle.

### Server components — explicitly NOT used

This app's UI lives entirely in the Tauri webview pointed at a local Vite dev server. There is no server boundary. RSC adds zero value here and adds confusion for any contributor who's learned RSC elsewhere. Hard no.

## 6. Token authoring + propagation

Two options:

- **Hand-curated `tokens.css`** — One file, one place to look, version-controlled, no build step. The design context already specifies tokens as CSS custom properties on `:root`. Use this for v1.
- **Style Dictionary v4** — Useful if tokens need to leave the web (iOS, Android, Figma, JS). Overkill for a local-only Tauri app.

Recommend hand-curated for now; reserve Style Dictionary for the day a second consumer appears.

### File layout

```
shell/src/tokens/
├── tokens.css          # spacing, type, radii, elevations (theme-invariant)
├── theme-light.css     # surfaces, text, borders at [data-theme="light"]
├── theme-dark.css      # surfaces, text, borders at [data-theme="dark"]
└── user-overrides.css  # written at runtime by the design REPL / user settings
```

The user-overrides file is the load-bearing piece for the "user picks an accent, contrast warning chip appears" affordance. It's a generated file (gitignored) that the runtime regenerates from user settings stored in `~/.local/share/maximal/`.

### HMR behavior

Vite HMR-imports CSS without remounting React components. A `--space-4` edit propagates in ~50ms, focus survives, scroll survives. This is true *only when the file is imported as a side-effect* (`import "./tokens.css"`), not when it's imported via `?inline` or `?raw`.

Acceptance test: open the Settings window in dev, focus the second input on the third section, edit `--space-5` in `tokens.css`, save. Focus and scroll position must survive. If they don't, something in the import graph is forcing a full reload — find it before adding more tokens.

### Design REPL — in-app token inspector

A dev-only panel mounted at the bottom of every window (hidden behind `Cmd-Shift-D`) lets a designer:

- See the current values of every `--space-*`, `--text-*`, `--surface-*`, `--accent`.
- Tweak each with a slider / color picker.
- See the change apply *across every window* in real time (broadcast via a Tauri event, or via `BroadcastChannel` if the windows share an origin).
- "Copy as CSS" to paste the trial values back into `tokens.css`.
- "Reset" to revert.

Sketch:

```tsx
// src/components/DesignRepl.tsx — dev-only, tree-shaken in prod via NODE_ENV check.
export function DesignRepl() {
  const [tokens, setTokens] = useAtom(tokenOverridesAtom);
  if (process.env.NODE_ENV !== "development") return null;
  return (
    <Drawer trigger="Cmd-Shift-D">
      {SPACE_TOKENS.map(name => (
        <RangeInput
          key={name}
          label={`--${name}`}
          min={0}
          max={96}
          step={2}
          value={tokens[name]}
          onChange={v => {
            setTokens({ ...tokens, [name]: `${v}px` });
            document.documentElement.style.setProperty(`--${name}`, `${v}px`);
            broadcastTokenChange(name, `${v}px`);
          }}
        />
      ))}
      <CopyAsCss tokens={tokens} />
    </Drawer>
  );
}
```

The REPL is not for end users. It's the "tighten this spacing" affordance for the design workflow in section 8.

## 7. Per-layer mapping

The L1–L5 model from `design-feedback-loops-practices.md`, with the tools from this stack pinned to layers:

| Layer | Budget | Tools |
|---|---|---|
| **L1** Deterministic | <2s | `stylelint` + `stylelint-declaration-strict-value`, `eslint-plugin-jsx-a11y`, custom AST passes (smart-quote, font, card-purpose), `colord`-based token-on-token contrast |
| **L1.5** Dev console | <1s | `@axe-core/react` injected by `axeDevPlugin`, `why-did-you-render` |
| **L2** LLM review | <5s | gemma-2-9b-instruct via Ollama on the diff + `.design-context.md` (per loops doc) |
| **L3** Rendered checks | 10–30s | `@axe-core/playwright`, `toMatchAriaSnapshot`, `page.metrics()` |
| **L4** Visual regression | minutes | Playwright `toHaveScreenshot` in container, light/dark × 3 accents × 3 windows |
| **L5** Observation | non-blocking | `scripts/design-watch.ts` tailing JSONL, posting to local viewer |

Any tool that can't meet its layer's budget moves down a layer. `@axe-core/react` lives at L1.5 because its dev-time injection is cheap and *non-gating* — it logs to the console; it doesn't fail the hook. The L1 hook still finishes in <2s because the axe pass runs in the browser, not in the hook.

## 8. Iterative workflow — a 30-minute design session

Concrete scenario: tighten the spacing in the Settings window's Routing section.

1. `bun run app:dev` — Vite + Tauri shell up. Three windows pop. Console shows axe pass (no violations).
2. Open Settings → Routing. Open DevTools, switch to React DevTools Components tab. Hover the Routing card; the component is `RoutingPane > ProviderList > ProviderCard`.
3. `Cmd-Shift-D` — design REPL drawer slides up. Drag `--space-5` from 24 → 20. Every card on every visible window reflows in <100ms. The accent contrast chip stays green.
4. Try `--space-5` at 18 — the chip nudges to "WCAG AA 3.8:1" on a nested label. Pull back to 20. Settle.
5. Click "Copy as CSS" in the REPL. Paste into `tokens.css`. Save.
6. Vite HMR fires. The L1 hook fires in parallel: `stylelint` validates the file in ~300ms, custom AST passes do a quick check, exits 0. The transcript is silent.
7. Run `bun run design:visual` *optionally* — opens the Playwright container, regenerates snapshots, opens the diff in a browser if anything moved. Light/dark × 3 accents × 3 windows = 18 shots, ~40s.
8. `git diff tokens.css` shows the one-line change. Commit.

What made it 30 minutes and not a day:

- The REPL meant the designer never typed pixels into a stylesheet to feel them. Sliders + immediate visual feedback.
- HMR meant the experiment loop was 100ms, not 3s.
- The L1 hook caught nothing because there was nothing to catch — but it *would* have caught a raw `padding: 17px` if the designer had typed it instead of using the REPL slider.
- L4 was opt-in. The designer ran it only after settling, not on every keystroke.

What goes wrong if you skip the stack:

- Without the REPL, the designer types values, saves, alt-tabs, looks. 5s per iteration × 50 iterations = the session.
- Without HMR for tokens, every save reloads. Focus lost, scroll lost. The designer stops nudging by 1px because the friction isn't worth it. Tokens stay at the values an agent generated.
- Without `stylelint-declaration-strict-value`, the designer eventually writes `padding: 17px` and forgets. It's invisible at PR review.

## 9. Container boundary — what runs where

Per `design-feedback-loops-practices.md` section "Workspace decision":

**Host (no container):**

- Vite dev server. Tauri shell. React DevTools (browser extension or standalone).
- L1 hooks: stylelint, AST passes, contrast math. All Node/Bun, sub-second.
- L2 reviewer: Ollama runs natively on Darwin; container would lose GPU access.
- The design REPL (it's part of the app).
- The L5 watcher (`scripts/design-watch.ts`).

**Container:**

- Playwright + Chromium for L3 (a11y, aria, perf) and L4 (visual regression).
- vnu, lighthouse-ci, pa11y-ci if added later.

**Why container for L4 specifically:** font rendering differs between macOS and Linux. A snapshot generated on a designer's Mac will diff against CI run on Linux every time. The container fixes the OS, the libc, and the font stack. Microsoft's official `mcr.microsoft.com/playwright` image is the right base.

**Dockerfile sketch:**

```dockerfile
FROM mcr.microsoft.com/playwright:v1.50.0-jammy
WORKDIR /work
RUN npm i -g @axe-core/cli pa11y-ci @lhci/cli
COPY tests/ /work/tests/
COPY playwright.config.ts /work/
COPY shell/src/tokens/ /work/tokens/
# Mount shell/src/ at runtime; baselines write back into tests/visual/.
ENTRYPOINT ["npx", "playwright"]
```

Invocation from the host:

```sh
docker run --rm \
  -v "$PWD/tests:/work/tests" \
  -v "$PWD/shell/src:/work/shell/src:ro" \
  --add-host=host.docker.internal:host-gateway \
  design-tools test --update-snapshots
```

The `--add-host=host.docker.internal:host-gateway` line is the macOS-specific incantation that lets the container reach the host's Vite server. On Linux it's a no-op.

**Cache the Playwright browsers across runs** by binding `~/.cache/ms-playwright` into the container as a named volume; otherwise every cold start re-downloads ~400MB.

## 10. Scripts to wire into `package.json`

```jsonc
{
  "scripts": {
    "dev": "vite",
    "app:dev": "tauri dev",                                   // shell + sidecar + vite

    "ladle": "ladle serve",                                   // component sandbox
    "ladle:build": "ladle build",

    "lint:css": "stylelint 'src/**/*.css' 'src/**/*.tsx'",
    "lint:a11y": "eslint 'src/**/*.tsx' --rule 'jsx-a11y/*'",

    "design:check": "docker compose run --rm design-tools test tests/a11y",
    "design:visual": "docker compose run --rm design-tools test tests/visual",
    "design:visual:update": "docker compose run --rm design-tools test tests/visual --update-snapshots",
    "design:trace": "docker compose run --rm design-tools test tests/walkthrough --trace on",

    "design:watch": "bun scripts/design-watch.ts"             // L5 observer
  }
}
```

`design:check` and `design:visual` are the L3/L4 hands of the design-feedback-loops doc. They're explicitly user-invoked; they do not run on every edit.

## 11. Open questions

- **Vite 7 → 8 cutover.** Vite 8 (March 2026) ships Rolldown and is a 10–30× build speedup. Three plugins in this stack (`@mdx-js/rollup`, `@vitejs/plugin-react`, Ladle) need Vite-8-tested releases before adoption. Re-check quarterly.
- **React 19 → 20.** React 19 is stable; 20 is rumored. No action; the stack doesn't depend on 19-only features today (no `use()`, no Actions in the hot path).
- **Playwright on Apple Silicon vs CI x86.** Even in a container, ARM vs x86 produces subpixel font differences. `maxDiffPixelRatio: 0.01` absorbs it; if CI runs on x86 and developers are on ARM, expect a small ongoing diff rate.
- **`.design-context.md` → `tokens.css` sync.** Today this is manual: edit the doc, edit the CSS, hope they agree. A pre-commit guard that fails when `tokens.css` changes without `.design-context.md` changing in the same diff would help. Possibly a generator script that reads tokens from the doc's fenced CSS block and writes `tokens.css` — but the doc's CSS block is *prose-authored* and includes prose comments, so a parser pass is non-trivial.
- **MDX for help surfaces vs separate help window.** MDX is set up here for in-app docs. If the project decides the help surface is a separate proxy-served page (per the design-context's "the proxy-served HTML pages"), MDX moves to the proxy side and `@mdx-js/rollup` becomes a backend dep. Unresolved.
- **Storybook escape hatch.** If a designer needs visual diff approval workflows that Playwright's report doesn't deliver (annotation, approval buttons, history), add Storybook + Chromatic later. The shape of this stack doesn't prevent it; nothing in Ladle locks anyone in.
- **Vanilla-extract or Panda CSS as a future option.** Both ship typed CSS-in-JS with zero-runtime output. If the team grows past three developers, the type-safety win on token references becomes meaningful. Today, the `stylelint-declaration-strict-value` rule plus IDE autocomplete on CSS variables is enough.
- **`@axe-core/react` in production.** It's dev-only here because the runtime cost (~1s per page load, plus a small bundle) is wasted on end users who can't act on console warnings. Open question: ship a "report a contrast issue" affordance in the user-themable accent picker that runs axe on demand. Probably yes, eventually.
- **Tauri webview Chromium drift.** Tauri's webview is the OS's WebView2 / WKWebView, not bundled Chromium. Playwright tests run against bundled Chromium. A feature works in Playwright but not in the actual shell, or vice versa. Mitigation: pin Playwright's Chromium version to track the lowest-supported WebView version, and run a periodic smoke test inside the actual Tauri shell (the `tauri test` story is still early; for now, manual).

Sources consulted: Vite release notes (v7/v8), Ladle v3 docs and the LogRocket/PkgPulse comparisons, Playwright docs on `toHaveScreenshot` / `toMatchAriaSnapshot` / Docker, Adobe react-aria release pages, Style Dictionary v4 migration docs, `stylelint-declaration-strict-value` README.
