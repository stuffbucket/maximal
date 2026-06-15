# CLAUDE.md

Index of where to look for what. This file is intentionally short — its
job is to make sure you know **what kinds of knowledge exist in this
repo and where to find them**, not to repeat that knowledge inline.
Always read the linked doc before acting in its area.

## When you're about to…

| Do this | Read this first |
|---|---|
| Run any script (`bun run …`), set up dev, iterate on the Tauri UI | [`docs/commands.md`](docs/commands.md) |
| Touch routing, middleware, model dispatch, config, token store, diagnostics, or the Tauri sidecar | [`docs/architecture.md`](docs/architecture.md) |
| Write or modify tests (especially mocks) | [`docs/architecture.md`](docs/architecture.md) → *Testing gotchas* |
| Open a PR, change commit conventions, cut a release | [`docs/architecture.md`](docs/architecture.md) → *Release & PR conventions* + [`docs/release-runbook.md`](docs/release-runbook.md) |
| Spawn parallel agents / use git stash | [`docs/architecture.md`](docs/architecture.md) → *Parallel-agent convention* |
| Change `.bun-version` or CI's Bun pin | [`docs/bun-version-policy.md`](docs/bun-version-policy.md) |
| Write any code | [`docs/code-style.md`](docs/code-style.md) |
| Touch any HTML, CSS, or component code (Tauri windows, proxy-served pages) | [`.design-context.md`](.design-context.md) — front door; topic deep-dives in [`docs/design/`](docs/design/). **Read `docs/design/failure-modes.md` before any non-trivial UI change.** |
| Work with the Claude Code or Opencode plugin | [`docs/plugins.md`](docs/plugins.md) |
| Dispatch or review codegen feedback loops | [`docs/codegen-feedback-loops-practices.md`](docs/codegen-feedback-loops-practices.md) |

## Other knowledge in this repo

- `docs/decisions/` — architecture decision records
- `docs/spec/` — feature specs
- `docs/dev/` — developer notes
- `docs/admin/` — operational docs
- `docs/*-prd.md` — product requirement docs for individual surfaces
- `research_log/` — dated investigation notes

If you don't find what you need in a linked doc, **search `docs/` and
`research_log/` before asking or inferring**. Earned knowledge lives in
those files; don't reinvent it.

## House rules (the few that must live here)

- **Never `git stash pop` in a shared working tree.** See architecture doc → *Parallel-agent convention* for why. Use a worktree for any isolated bisect.
- **PR titles are Conventional Commits** (`feat:` / `fix:` / `chore:` / etc.) — squash-merge uses the title verbatim. See architecture doc → *Release & PR conventions*.
- **Pin matters.** `.bun-version` and `.github/workflows/ci.yml` move together. See Bun version policy.
- **Design context overrides this file** for any UI work. Read `.design-context.md` and the relevant `docs/design/*.md` topic file.
