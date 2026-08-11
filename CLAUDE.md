# CLAUDE.md

Read the linked doc before you work in its area.

## Before a task

| Task                                                                                                   | Read first                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run a script (`bun run …`) or set up the dev environment                                               | [`docs/commands.md`](docs/commands.md)                                                                                                                                                      |
| Change routing, middleware, model dispatch, config, the token store, or diagnostics                    | **Wrong repo** — that is the engine, and it lives in [`stuffbucket/maximal-core`](https://github.com/stuffbucket/maximal-core). See [`docs/architecture.md`](docs/architecture.md) for the split. |
| Change packaging, the published CLI, or the site                                                       | [`docs/architecture.md`](docs/architecture.md)                                                                                                                                              |
| Write or change tests                                                                                  | [`docs/architecture.md`](docs/architecture.md) → _Testing_                                                                                                                                  |
| Open a PR, change commit conventions, or cut a release                                                 | [`docs/architecture.md`](docs/architecture.md) → _Release & PR conventions_ and [`docs/release-runbook.md`](docs/release-runbook.md)                                                        |
| Spawn parallel agents or use git stash                                                                 | [`docs/architecture.md`](docs/architecture.md) → _Parallel-agent convention_                                                                                                                |
| Change `.bun-version` or the CI Bun pin                                                                | [`docs/bun-version-policy.md`](docs/bun-version-policy.md)                                                                                                                                  |
| Write any code                                                                                         | [`docs/code-style.md`](docs/code-style.md)                                                                                                                                                  |
| Change any HTML, CSS, or component code (proxy-served pages)                                           | [`.design-context.md`](.design-context.md), then the topic doc in [`docs/design/`](docs/design/). Read [`docs/design/failure-modes.md`](docs/design/failure-modes.md) before any UI change. |
| Work on the Claude Code or Opencode plugin                                                             | [`docs/plugins.md`](docs/plugins.md)                                                                                                                                                        |
| Dispatch or review codegen feedback loops                                                              | [`docs/codegen-feedback-loops-practices.md`](docs/codegen-feedback-loops-practices.md)                                                                                                      |
| Change i18n catalogs or translation wording (`i18n/catalogs/`)                                         | [`i18n/README.md`](i18n/README.md) and [`docs/dev/i18n.md`](docs/dev/i18n.md). Ask the i18n expert in [`CONTRIBUTORS.md`](CONTRIBUTORS.md).                                                 |

## Other docs

- `docs/decisions/` — architecture decision records
- `docs/spec/` — feature specs
- `docs/dev/` — developer notes
- `docs/admin/` — operational docs
- `docs/*-prd.md` — product requirement docs per surface
- `research_log/` — dated investigation notes
- `CONTRIBUTORS.md` — domain experts to consult per area

If a linked doc does not answer your question, search `docs/` and
`research_log/` before you ask or infer.

## House rules

- **Never run `git stash pop` in a shared working tree.** Use a worktree for an isolated bisect. See [`docs/architecture.md`](docs/architecture.md) → _Parallel-agent convention_.
- **The proxy engine is not in this repo.** Routing, middleware, model dispatch, config, the token store, and diagnostics all live in [`stuffbucket/maximal-core`](https://github.com/stuffbucket/maximal-core). This repo packages it, ships the Electron client, and hosts the site.
- **GitHub Pages deploys are frozen.** Restoring them takes two steps, not one. See [`docs/architecture.md`](docs/architecture.md) → _Site and Pages_.
- **Write each PR title as a Conventional Commit** (`feat:`, `fix:`, `chore:`). See [`docs/architecture.md`](docs/architecture.md) → _Release & PR conventions_.
- **Update `.bun-version` and `.github/workflows/ci.yml` in the same commit.** See [`docs/bun-version-policy.md`](docs/bun-version-policy.md).
- **For UI work, follow `.design-context.md` before this file.** Read it and the topic doc in `docs/design/`.
