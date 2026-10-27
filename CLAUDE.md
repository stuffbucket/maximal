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
| Touch the Claude Code integration (`settings.json`, `apiKeyHelper`) | [`docs/plugins.md`](docs/plugins.md) |
| Touch the Codex integration | [`docs/dev/codex-integration.md`](docs/dev/codex-integration.md) |
| Touch a `/v1/messages` or client-auth wire contract | [`docs/spec/wire/`](docs/spec/wire/) |
| Touch i18n catalogs / translation wording (`shell/src/i18n/`) | [`docs/dev/i18n.md`](docs/dev/i18n.md); loop in the i18n expert per [`CONTRIBUTORS.md`](CONTRIBUTORS.md) |

## Other knowledge in this repo

- `docs/decisions/` — the few decision records still in force (CodeQL suppressions, Copilot coupling, the site version manifest)
- `docs/dev/` — developer notes (testing strategy, i18n, Codex, Windows VM)
- `docs/admin/` — operational docs
- `CONTRIBUTORS.md` — trusted domain experts to loop in per area

**The code is the authority.** Docs here describe current behavior only — no plans, research notes, or history (that lives in git). If a doc disagrees with the code, trust the code and fix the doc in the same change. Don't add dated investigation notes or proposals to the repo.

## House rules (the few that must live here)

- **Never `git stash pop` in a shared working tree.** See architecture doc → *Parallel-agent convention* for why. Use a worktree for any isolated bisect.
- **No unrestored `mock.module` in tests** — `void mock.module(…)` / bare `mock.module(…)` leak across files and are a lint error (`mockModuleLeakGuard`). Awaiting isn't enough for shared modules; prefer the real module (temp `COPILOT_API_HOME` / `CLAUDE_CONFIG_DIR`) or injectable deps. See architecture doc → *Testing gotchas*.
- **PR titles and commit subjects are Conventional Commits** (`feat:` / `fix:` / `chore:` / etc.) — a squash lands the PR title, a merge commit lands every branch commit; hook + CI enforce it. See architecture doc → *Release & PR conventions*.
- **Tidy branches with `bun run git:tidy`, never `git branch -D`;** keep the primary checkout detached at `origin/main` and never check out `main` in a worktree. See architecture doc → *Parallel-agent convention*.
- **Pin matters.** `.bun-version` and every workflow `bun-version:` move together. See Bun version policy.
- **Design context overrides this file** for any UI work. Read `.design-context.md` and the relevant `docs/design/*.md` topic file.
