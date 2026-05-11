# Design feedback loops — inner, outer, and the taste tail

## Problem framing

LLM coding agents that touch UI generate plausible-looking surfaces faster than a human can review them. The failure mode is not "the page doesn't render" — it's "the page renders, looks fine, and quietly violates the design system in six places." A raw hex slips into a stylesheet, a bare `font-family: Inter` lands in a component, `padding: 17px` shows up because the agent rounded badly, a card wraps a section heading. None of it crashes. All of it accumulates.

The lever is the same as for codegen: latency. A signal that arrives before the next turn shapes the next generation. A signal that arrives at PR review is a refactor. The premise of this doc is that **design quality decomposes into three pieces**:

- A **deterministic** chunk that a parser can check in milliseconds: tokens, contrast math, approved fonts, semantic HTML, smart-quote enforcement.
- A **reviewable** chunk that a small local LLM can judge in a few seconds: does this layout match `.design-context.md`? Is the card-purpose rule being followed? Is this an AI-dashboard archetype?
- A **taste tail** that only a human can decide: does this feel warm? Does it feel crafted? Is the copy "Sign in with GitHub" or "Authenticate via OAuth"?

This doc applies the codegen two-tier model (see `docs/codegen-feedback-loops-practices.md`) to the first two chunks, and is explicit about the third.

What's different from codegen:

- **No LSP equivalent.** TypeScript has `tsc`; design has no editor-resident truth-teller. The inner loop is the first signal, not the second.
- **Render dependency.** A real contrast check needs computed styles, which need a render. Static checks can catch the obvious cases (token-on-token pairings) but a full a11y audit waits on a headless browser.
- **The taste tail is irreducible.** No tool catches "this looks like a CRUD admin panel." A human still has to look.
- **Canonical source of truth lives in prose.** `.design-context.md` is the spec; tools enforce conformance to it. The doc is load-bearing — if it drifts from the tokens shipped in CSS, every L2 review is wrong.

## Layered model L1–L5

| Layer | Hook point | Frequency | Latency budget | What it surfaces |
|---|---|---|---|---|
| **L1** Deterministic | PostToolUse on `*.css`/`*.tsx`/`*.html` | Every file write | <2s | Token violations, contrast math on static pairings, approved-font, smart quotes, card-purpose comment |
| **L2** LLM reviewer | Stop (end of agent turn) | Every assistant turn | <5s | Anti-patterns vs `.design-context.md`, AI-slop archetype, card misuse, copy tone |
| **L3** Rendered checks | `design:check` script | On demand | 10–30s | axe-core full audit, pa11y, computed contrast on real DOM, semantic HTML conformance |
| **L4** Visual regression | `design:visual` script, pre-PR | On demand or CI | minutes | Lost Pixel / Playwright snapshots against approved baselines |
| **L5** Observation | Side process tailing JSONL | Continuous | non-blocking | Local LLM meta-analysis: drift from `.design-context.md`, repeated violations, taste-tail hints |

L1 and L2 map to the codegen inner and outer loops. L3 and L4 are manual aggregates (codegen's `check:fast` / `check:deep`). L5 reuses the gemma-watch pattern: a tail process, never a gate.

Hook-harness wiring (Claude Code): L1 runs from `PostToolUse`, L2 runs from `Stop`, L3/L4 are user-invoked, L5 is a long-lived `bun run analyze:design`. Same shape as the codegen loops, separate command paths so they can fail or be disabled independently.

## L1 rules to ship in v1

The inner loop runs four checks in parallel on every CSS/TSX/HTML save. Silent on success, exit 2 with compact stderr on failure. Scoped to the edited file.

| Rule | Tool | Latency | What it catches |
|---|---|---|---|
| Token-only colors | `stylelint` + `stylelint-declaration-strict-value` | 100–400ms | `color: #c8334a` instead of `color: var(--accent)` outside the token-definition file |
| Token-only spacing | same | included | `padding: 17px`, `gap: 1rem` instead of `var(--space-4)` |
| Token-only type sizes | same | included | `font-size: 14px` instead of `var(--text-sm)` |
| Approved-font | custom stylelint rule + regex AST pass | 50–200ms | `font-family: Inter` — bare names; only `var(--font-display|body|mono)` allowed |
| Static contrast | `colord` + small TS pass | 200–500ms | Any `color`/`background-color` pair declared in the same file where both resolve to token literals; flag <4.5:1 body, <3:1 large |
| Card-purpose comment | regex pass on `.tsx`/`.css` | <50ms | Any selector matching `.card`/`Card` chrome (`background`, `border-radius`, `box-shadow`) without an adjacent `/* card-purpose: ... */` comment naming the entity |
| One humanist accent per file | regex pass | <50ms | More than one `var(--font-display)` reference in a single component file |
| Smart-quote / em-dash in JSX | custom AST pass via `@babel/parser` | 200–400ms | `"don't"` in JSX text instead of `"don’t"`; ` -- ` instead of `—` in prose strings |

Wall-clock is the slowest of these run in parallel. Realistic budget on a warm cache: 500–800ms.

### Token-only enforcement (the load-bearing rule)

`stylelint-declaration-strict-value` is the workhorse. One config block enforces all three token families:

```json
{
  "plugins": ["stylelint-declaration-strict-value"],
  "rules": {
    "scale-unlimited/declaration-strict-value": [
      ["/color/", "/^(margin|padding|gap|inset)/", "font-size", "border-radius", "box-shadow"],
      { "ignoreValues": ["0", "transparent", "inherit", "currentColor", "none", "auto"] }
    ]
  },
  "ignoreFiles": ["**/tokens.css", "**/design-context.css"]
}
```

The token-definition file is the one place raw values live. Everywhere else, a non-token literal is an error. The `ignoreValues` list is short on purpose; the agent should not be able to argue its way to a new exemption.

### Approved-font enforcement

Stylelint can check CSS, but not the inline `style={{ fontFamily: "..." }}` that React lets through. A small AST pass over TSX is required. The rule: any `fontFamily` attribute or any `font-family` declaration must reference `var(--font-display)`, `var(--font-body)`, or `var(--font-mono)`. Bare strings — even browser defaults — are forbidden by the design context's explicit "no generic stack" rule.

### Static contrast

A full contrast check needs a render. A useful subset does not: when both `color` and `background-color` (or `background`) are declared in the same rule and both resolve to token values that the script knows, compute WCAG contrast with `colord` (1.7KB, zero deps, has `.contrast()`). Warn at <4.5:1 for body text, <3:1 for large or non-text. The script imports `tokens.css` once at startup, builds a name→hex map, and uses it for resolution. This misses pairings spread across selectors, inherited colors, and user-themed accents — those live at L3.

### Card-purpose comment

The design context bans cards-as-section-chrome. The rule is hard for a parser to enforce directly, but a proxy works: any CSS that defines card chrome (background fill + border-radius + padding, or any class named `*Card` / `.card-*`) must be accompanied by an adjacent `/* card-purpose: <entity> */` comment. The comment forces the author to name the entity the card represents; if they can't name one, the squint test failed and they shouldn't be using a card. This is a discipline check, not a correctness check.

### What does NOT belong at L1

- Full a11y audit. axe-core is fast for a browser engine but slow for a hook; renders are 1–3s and bust the budget. Move to L3.
- Visual regression. Requires a render and a baseline; that's L4.
- "Does this look like an AI dashboard." Needs judgment; that's L2 or a human.
- Bundle size. Builds take longer than the budget; that's CI.

## L2 LLM-as-reviewer

The outer loop runs once at the end of the agent turn. It hands the diff plus `.design-context.md` to a small local model (gemma-2-9b-instruct or similar, via Ollama) and asks a structured question set.

**Prompt shape** (sketch — actual prompt should live in `.claude/hooks/design-review-prompt.txt`):

```
You are reviewing a UI diff against the project's design context.

DESIGN CONTEXT:
<contents of .design-context.md>

DIFF:
<contents of `git diff` scoped to *.css, *.tsx, *.html since last turn>

Answer each question. Output JSONL, one row per question. Each row:
  {"q": "<id>", "verdict": "ok|warn|fail", "note": "<one sentence>"}

Questions:
1. card-misuse: Does any new card wrap a section heading instead of a discrete entity?
2. ai-slop: Does the change resemble the AI-dashboard archetype (grid of similar cards, icon-heading-text rows)?
3. humanist-accent: Is the brand mark or one Fraunces heading used more than once per window?
4. copy-tone: Does any new user-facing string use machine voice ("Initiate", "Configure", "Authenticate")?
5. density: Is row padding noticeably tighter than the comfortable density the context calls for?
6. motion: Does any new animation ignore prefers-reduced-motion?
```

**Output discipline:**

- JSONL, one row per question, written to `~/.local/share/maximal/logs/design-review-<date>.jsonl`.
- Hook stderr surfaces only rows with verdict `fail`; `warn` rows go to the JSONL stream for L5 only.
- Exit 0 unless the project is configured as gating. Default is observation-only — same rule as codegen's L5: an LLM reviewer that blocks turns becomes a thrash engine.

**Model choice:** gemma-2-9b-instruct on Ollama matches the existing `scripts/gemma-watch.ts` pattern. ~3s for a 4KB diff on an M-series Mac. Anything bigger (Qwen-14B, Llama-3.1-70B) busts the 5s budget. Anything smaller (gemma-2-2b) misses the card-misuse and AI-slop categories in practice.

**Gating switch:** project-level opt-in via a `designReview.gate: true` flag in repo config. Off by default. Even when on, only verdicts of `fail` block; `warn` is advisory.

## Tool survey

Each entry: where it fits, latency expectation, one-line justification, install sketch.

### CSS and token enforcement

- **`stylelint`** (L1). Mature, plugin-driven, ~200ms warm on a single file. The host for the strict-value plugin. `bunx stylelint <file>`. MIT, actively maintained.
- **`stylelint-declaration-strict-value`** (L1). Forces variables/functions for the properties you list. The single most important plugin in this stack. MIT, maintained by AndyOGo.
- **`stylelint-use-logical`** (L1, optional). Enforces logical properties (`margin-inline-start` over `margin-left`). Useful if i18n is on the roadmap; cosmetic if not. `csstools` org, actively maintained.
- **`oxlint`** (L1, JS/TS only). The repo already runs it for codegen. No CSS rules; do not double-count it here.
- **`lightningcss`** (not a linter). Often surfaces as a linting option in tooling write-ups, but it is a parser/transformer/minifier. Useful as the parsing engine for a custom rule, not a drop-in checker. Skip unless writing custom plugins.
- **`@eslint/css`** (L1, emerging). ESLint's official CSS plugin landed in early 2025. Promising as a future replacement for stylelint when its rule set catches up; today it lacks a token-enforcement rule strong enough to retire stylelint.

### Accessibility

- **`axe-core`** (L3). The industry-standard a11y engine. Runs in a headless browser; ~1–3s per page. Powers Lighthouse, Storybook a11y, and most managed offerings. MIT, maintained by Deque.
- **`pa11y`** (L3). CLI wrapper that drives axe-core (default is HTML_CodeSniffer, axe is configurable). Easier to script in CI than axe-core directly. Use for batch URL audits.
- **`lighthouse-ci`** (L4). Google's full audit suite — a11y, performance, best practices, SEO. ~10–30s per URL. Right tool for pre-PR; wrong tool for per-edit. CI-friendly via `lhci autorun`.
- **`eslint-plugin-jsx-a11y`** (L1). Static AST check for JSX a11y rules — `alt` on `img`, `htmlFor` on `label`, role/required-attribute pairings. Cheap, catches the easy cases before a render is needed. Pair it with axe-core at L3 for the cases static analysis can't see.
- **`colord`** (L1 dependency). 1.7KB tree-shakeable color library with a `.contrast(other)` method that returns WCAG ratio. Use it to score token-on-token pairings in the L1 static contrast check.
- **`culori`** (alternative to colord). Heavier, broader gamut support (Oklch, P3). Overkill for v1; revisit if the design system adopts wide-gamut color.

### Visual regression

- **`playwright`** + built-in screenshot diff (L4). Open-source, headless across Chromium/Firefox/WebKit. The "bring your own renderer" choice. Pair with `reg-suit` if you want managed baselines without a paid service.
- **`lost-pixel`** (L4). Open-source alternative to Percy/Chromatic. Supports Storybook, Ladle, Histoire, and full-page shots. Uses Docker to standardize rendering, which dovetails with the L3+ container recommendation below. Worth a first look for any project that already runs Storybook.
- **`reg-suit`** (L4). Comparison + storage + CI integration; you bring the screenshot generator. The most flexible choice; also the most assembly required.
- **`percy`**, **`chromatic`**, **`applitools`** (L4, paid). Managed services. Lower setup cost than self-hosting; ongoing cost and a third-party data flow. Mention to readers; don't recommend by default for projects with a local-first posture.

### Component sandboxing

- **`storybook`** (L4 substrate). The default. Slow to start (~8–10s cold) but the ecosystem is unmatched: a11y addon, visual regression integrations, Chromatic. Pick this if you want one tool that L3 and L4 both target.
- **`ladle`** (L4 substrate, React only). Vite-native, 1.2s cold start, ~6.7x faster than Storybook. No first-party a11y or visual-regression integrations — pair with Playwright. Good fit for React-only repos that value startup speed.
- **`histoire`** (L4 substrate, Vue/Svelte). Vite-native, ~2s start. The Vue analogue to Ladle. Not relevant if your stack isn't Vue/Svelte.

### Typography and copy

- **Custom AST pass via `@babel/parser`** (L1). The only honest way to catch curly quotes, em-dashes, and bare font strings in JSX. Write the script once; it lives in `.claude/hooks/check-design-on-edit.ts`.
- **`prettier`** (peripheral). Useful for general formatting; not a substitute for a smart-quote rule. Its `--quote-props` and string-quote options operate at the syntax level, not on string content.
- **`eslint-plugin-tailwindcss`** (irrelevant unless on Tailwind). Sorts classes, flags unknown utilities. No signal for design-token enforcement when not using Tailwind.

### Design-token authoring

- **`style-dictionary`** (L0 — upstream). Amazon's multi-platform token build tool. Source of truth lives in JSON; outputs CSS, iOS, Android, JS. Recommended if tokens need to leave the web. For a web-only project, hand-writing `tokens.css` is fine and lets `.design-context.md` stay the canonical doc. Style-Dictionary v4 series supports DTCG (Design Tokens Community Group) spec.
- **`tokens-studio`** (Figma-side). Useful if designers author tokens in Figma. Not relevant to enforcement; mention for completeness.

### Performance and budgets

- **`lighthouse-ci`** (L4). Best for batch perf + a11y reporting in CI. Latency too high for L1 or L2.
- **`web-vitals`** (runtime). A small library you embed for live measurement. Useful for L5 (observation) if you want runtime signal alongside hook output; out of scope for L1–L4.
- **`size-limit`** (L4 / CI). Bundle-size budgets that fail builds. Maintained, JSON config, plays well with CI.
- **`bundlewatch`** (L4 / CI alternative). Similar shape to size-limit. Either is fine; don't run both.

### HTML and markup

- **`htmlhint`** (L1, optional). Fast HTML linter, ~100ms. Catches duplicate IDs, missing `alt`, unclosed tags. Cheap insurance for static `.html` files.
- **`vnu`** (L3). The W3C Nu HTML Checker. Java-based; runs as binary or Docker image. Slow start, thorough — belongs in the on-demand container, not the per-edit hook.
- **`markuplint`** (L1/L2 boundary). Modern HTML linter with WAI-ARIA conformance rules; faster than vnu, more rules than htmlhint. Worth evaluating as the htmlhint replacement once it has a stable Bun/Node integration story.

### What does not exist (yet)

- **AI-slop visual detector at L1.** No reliable static tool today identifies the "grid of similar cards" archetype from CSS alone. L2 with an LLM reviewer is the current state of the art, and even that is best-effort. Do not pretend otherwise in tooling.
- **Reliable computed-contrast static checker.** The static L1 contrast pass catches token-on-token pairings; it does not catch inherited colors, user-themed accents, or nested overrides. That's a render-time check (L3), full stop.
- **Typography-rhythm linter.** Nothing programmatically flags "this heading uses the wrong size in the ramp for its semantic level." A custom rule mapping selectors (`h1`/`h2`) to required `var(--text-*)` references is possible to write, but no off-the-shelf tool ships it.

## Workspace decision: Docker container vs. host?

The question: should the design tools run in a container we can point at part of the repo, or on the host?

The honest answer is **hybrid**, and the dividing line is the latency budget.

**On the host (L1, L2, L5):**

- L1 deterministic checks. Stylelint, the AST passes, colord-based contrast math. All Node/Bun. Sub-second. Spinning up a container per edit would add 200–800ms of overhead and bust the inner-loop budget. No container.
- L2 LLM reviewer. Ollama already runs on the host (per the gemma-watch pattern). Crossing a container boundary for a 3s prompt adds latency and complicates GPU access on Mac. No container.
- L5 observation tail. Same reason as L2 — the JSONL stream is on the host, the watcher is on the host.

**In a container (L3, L4):**

- L3 axe-core / pa11y / vnu. Headless browsers and a Java runtime. Heavy host dependencies. Containerize and accept the cold-start cost once per session.
- L4 lost-pixel / playwright snapshots / lighthouse-ci. Renderers, baseline storage, deterministic rendering. Lost Pixel explicitly recommends a Docker image to standardize results across machines.

**Why containerize L3/L4:**

- Reproducibility. A teammate or an agent on a different machine gets the same a11y verdicts and the same screenshots.
- Isolation. Java (vnu), Playwright browser binaries (~400MB), and axe-core CLI dependencies don't pollute the host's `node_modules` or PATH.
- Scoping. The container only mounts the directories with UI. For this repo: `shell/src/`, `pages/`, `src/pages/`. Backend code in `src/lib/`, `src/routes/`, `src/services/` is not mounted — the design tools have no signal there and shouldn't see it.

**Dockerfile sketch** (~30 lines; do not commit until tested):

```dockerfile
FROM node:20-bookworm-slim
# Java for vnu, plus minimal deps for Playwright's Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
      default-jre-headless ca-certificates wget \
      libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libasound2 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /work

# Install the design toolchain once at build time.
RUN npm i -g \
      @axe-core/cli \
      pa11y pa11y-ci \
      lighthouse @lhci/cli \
      lost-pixel \
      markuplint \
      vnu-jar

# Playwright browsers (Chromium only is sufficient for v1).
RUN npx -y playwright@latest install --with-deps chromium

# Entrypoint dispatches subcommands: axe, pa11y, lhci, lost-pixel, vnu.
COPY design-run.sh /usr/local/bin/design-run
RUN chmod +x /usr/local/bin/design-run
ENTRYPOINT ["design-run"]
```

Invoke from the host as `docker run --rm -v $PWD/shell/src:/work/shell/src:ro -v $PWD/pages:/work/pages:ro design-tools axe http://host.docker.internal:4142/dashboard`. First run is 30s of container start plus the actual audit; subsequent runs reuse a long-lived container via `docker compose up -d design-tools` and exec into it.

**What goes wrong if you ignore the dividing line:**

- Containerizing L1 makes the inner loop a 3–5s round trip. The agent will move on before the signal arrives. The whole architecture stops working.
- Hosting L3/L4 means every contributor's machine has to install Playwright browsers, a JRE for vnu, and matching axe-core versions. Within a quarter the verdicts diverge by machine.

## Hook recipes

The codegen hooks already live at `.claude/hooks/check-on-edit.ts` and `.claude/hooks/check-on-stop.ts`. Add separate design hooks alongside them; do not bolt design checks onto the codegen ones — they fail for different reasons and the agent benefits from disambiguated stderr.

`.claude/settings.json` (additive; codegen entries unchanged):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          { "type": "command", "command": "bun .claude/hooks/check-on-edit.ts" },
          { "type": "command", "command": "bun .claude/hooks/check-design-on-edit.ts" }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "bun .claude/hooks/check-on-stop.ts" },
          { "type": "command", "command": "bun .claude/hooks/design-review-on-stop.ts" }
        ]
      }
    ]
  }
}
```

`.claude/hooks/check-design-on-edit.ts` (sketch):

```ts
// 1. Read the edited file path from stdin (Claude Code hook payload).
// 2. If extension is not .css/.tsx/.html/.svelte/.vue, exit 0 silently.
// 3. Spawn in parallel:
//    - bunx stylelint <file> (covers token-only rules)
//    - bun .claude/hooks/lib/check-fonts.ts <file>
//    - bun .claude/hooks/lib/check-contrast.ts <file>
//    - bun .claude/hooks/lib/check-quotes.ts <file>
// 4. Promise.all, collect failures, concat stderr.
// 5. Append one JSONL row to ~/.local/share/maximal/logs/design-edits-<date>.jsonl.
// 6. Exit 0 if all clean; exit 2 with compact stderr otherwise.
```

`.claude/hooks/design-review-on-stop.ts` (sketch):

```ts
// 1. Compute `git diff` since last turn, restricted to UI globs.
// 2. If diff is empty, exit 0.
// 3. Read .design-context.md.
// 4. POST to Ollama (gemma-2-9b-instruct) with the prompt template + diff + context.
// 5. Parse JSONL response.
// 6. Append all rows to ~/.local/share/maximal/logs/design-review-<date>.jsonl.
// 7. If gating is on AND any verdict is "fail": write fail rows to stderr, exit 2.
// 8. Otherwise exit 0.
```

`scripts/design-watch.ts` (the L5 observer; never invoked from a hook):

```ts
// Tail ~/.local/share/maximal/logs/design-*.jsonl.
// For each new row with verdict in {warn, fail}, batch with neighbors and
// feed to a local model with the prompt:
//   "Here are the last N design-rule violations. Identify (1) the single
//   most-repeated rule, (2) any drift from .design-context.md not already
//   covered by an L1 rule, (3) any taste-tail concerns a human should look at."
// Post the result to the same viewer scripts/gemma-watch.ts uses.
```

The `bun run analyze:design` script starts the watcher. It runs alongside `bun run analyze` (codegen) without contention — they tail different files and post to different viewer channels.

## Acceptance tests

Run each test against a freshly-installed hook config.

**L1 — token-only color**

1. Add `color: #ff0000;` to a `.tsx` style block. Save.
2. Confirm the agent transcript surfaces a stylelint error within 1s naming the property and pointing at `var(--accent)` or similar.
3. Replace with `color: var(--text-strong);`. Save. Confirm silent success.

**L1 — approved font**

1. Add `<div style={{ fontFamily: "Inter, sans-serif" }}>`. Save.
2. Confirm the font check fails with "use `var(--font-body)`".
3. Replace with `<div style={{ fontFamily: "var(--font-body)" }}>`. Save. Confirm silent success.

**L1 — static contrast**

1. Add a rule with `color: var(--text-muted); background: var(--surface-card);` where the resolved pair is <4.5:1 in dark mode.
2. Confirm the contrast check emits a warning naming the ratio and the resolved hex pair.

**L1 — smart-quote**

1. Add `<p>It's fine</p>` to a `.tsx` file (straight apostrophe).
2. Confirm the quote check fails with a suggestion to use `’`.

**L1 — card-purpose**

1. Add a `.SomeCard` class with `background`, `border-radius`, and `padding` but no adjacent comment.
2. Confirm the card-purpose check fails with "add `/* card-purpose: <entity> */` adjacent to card chrome".

**L2 — card misuse**

1. Wrap a section heading inside a new card. Trigger Stop.
2. Confirm the L2 review writes a `verdict: fail` row for `card-misuse` to the JSONL log within 5s.
3. If gating is off, confirm exit 0 and no stderr. If gating is on, confirm exit 2 with the one-sentence note.

**L3 — full a11y**

1. Run `bun run design:check`. Confirm container starts (cold ≤30s, warm <5s).
2. Introduce a button without an accessible name. Re-run. Confirm axe-core surfaces `button-name`.

**L4 — visual regression**

1. Run `bun run design:visual` against an approved baseline. Confirm zero diffs.
2. Change a button height from `36px` to `40px`. Re-run. Confirm a visible diff is reported with a screenshot.

**L5 — observation**

1. With `bun run analyze:design` running, introduce and revert the same token violation across three saves.
2. Confirm the watcher surfaces a "repeated violation: same hex re-introduced 3x" message in the viewer.

If all of these pass, the layers are wired correctly. If L1 latency exceeds 2s, profile the stylelint config — usually a too-broad `files` pattern or a missing cache.

## Anti-patterns

- **Gating on the LLM reviewer by default.** A small local model is wrong often enough that gating turns the outer loop into a thrash engine. Default to observation; flip to gate only on a project that has tested it.
- **Running axe-core in the inner loop.** Renders are 1–3s. The agent's next turn arrives before the verdict. Move to L3.
- **Letting the token file drift from `.design-context.md`.** When `tokens.css` and the prose doc disagree, every L1 contrast check is wrong and every L2 review cites the wrong values. Keep them in sync; commit them in the same change.
- **Adding tokens to silence a failing check.** A new `--space-17` because the agent wanted 17px is the inverse of the rule. Reject the value or pick the nearest existing token.
- **Wrapping every section in a card to satisfy a layout instinct.** The design context bans it; the L1 card-purpose check catches the chrome but not the misuse. L2 is the safety net; humans are the final one.
- **Per-developer design configs.** Like codegen, `.claude/settings.json` is committed. Personal overrides go in `.claude/settings.local.json`, which is gitignored. Diverging design loops mean diverging UI.
- **Coupling design failures into codegen hook exit codes.** They fail for different reasons. Keep the hooks separate so stderr disambiguates "this broke types" from "this broke the token rule."
- **Treating the LLM reviewer's output as truth.** It's a hint generator. The JSONL stream is for human triage; the failing verdict is a suggestion, not a verdict. The human is the verdict.
- **Mounting the whole repo into the design container.** The container has no signal on `src/lib/` or `src/services/`. Mount only the UI directories. Smaller surface, faster start, fewer false positives.

## When NOT to use this

- **No design system yet.** Without `.design-context.md` (or its equivalent) and a `tokens.css`, the L1 rules have nothing to enforce against. Write the design context first, ship one token, then turn on stylelint.
- **Source-only repos with no rendered UI.** A library that exports React components but never renders them in-tree has no L3/L4 surface. Run L1/L2; skip the container.
- **Marketing sites with one stylesheet.** The loop is overkill for a five-page brochure. A pre-commit stylelint and a Lighthouse run in CI is enough.
- **Projects on a closed design system with its own enforcement.** Atlassian, Shopify Polaris, and similar ship their own stylelint configs. Use theirs; don't bolt this on top.
- **Tauri-only / native UI with no HTML.** This doc assumes a web rendering layer. SwiftUI/AppKit need a different toolchain entirely.

## Open questions

- **User-themable accents and contrast.** The design context allows users to pick their own accent and surface colors. L1 contrast can only verify the default theme; the user-chosen combinations need a runtime check inside the app (a contrast warning chip near the affected control, per the design context). Is that the same code path as L3, or a separate runtime widget? Probably separate, but the validation logic should be shared.
- **Which local model for L2.** gemma-2-9b is good enough for card-misuse and copy-tone but mediocre at the AI-slop archetype. Worth re-evaluating quarterly as small models improve.
- **The taste tail.** L1+L2 cover the deterministic and the reviewable. The "does this feel humanist?" question has no good automated proxy. Current best practice: a human looks at every PR. Open question: whether L5's tail-aggregation across many turns can surface "you've drifted toward generic" earlier than a human catches it. Unproven.
- **Per-window vs. per-component scoping.** `.design-context.md` writes rules per-window (Setup, Dashboard, Settings); the file system tends to be per-component. The L1 file-scoped check can't know which window a component renders in. Either annotate components with `/* window: settings */` comments, or move the check to the route layer. Unresolved.
- **Storybook vs. Ladle for L4.** Ladle is faster; Storybook has the a11y addon and broader integrations. If L3 (axe-core) and L4 (lost-pixel) cover the same ground via separate tools, Ladle's speed wins. If you want one substrate for both, Storybook does.
- **What to do when a token genuinely needs to change.** The flow is: edit `.design-context.md` first, then `tokens.css`, then run the L1 checks. But nothing enforces that order. A pre-commit guard that fails the commit if `tokens.css` changes without `.design-context.md` changing in the same diff would help. Worth prototyping.
- **Whether to vendor a known-good `tokens.css` into the container.** Today the L3 contrast check reads the host's `tokens.css` via the mount. If it ever drifts at runtime, the verdicts drift. A snapshot at container build time would be stable but stale. Probably not worth solving until it bites.
