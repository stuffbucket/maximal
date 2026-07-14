# External-surface drift watch

**Domain:** GitOps / operational tooling — _not_ part of the maximal proxy.
This automation maintains the product; it is not shipped in it. It lives under
`scripts/ops/` and runs in GitHub Actions, deliberately outside the product's
`bun test` root (`bunfig.toml` → `[test] root = "tests"`) and outside
`docs/architecture.md`.

## Why it exists

The proxy impersonates several third-party clients and mirrors the Anthropic
`/v1/messages` wire contract. Those upstreams live outside this repo and move on
their own schedule, so a stale hardcoded pin fails **silently** in production
(the 421 endpoint-migration and stale client-version field reports both trace to
this class of drift). The watcher turns "did an upstream we mirror move?" into a
deterministic check with no LLM and no interactive auth.

## What it watches

Each pin is compared against an authoritative upstream. The pin in `src/` is the
single source of truth — the watcher reads it, never a duplicate.

| Pin (source of truth)                                               | Upstream authority                                          | Signal                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| `COPILOT_VERSION` — `src/lib/config/api-config.ts`                  | `microsoft/vscode-copilot-chat` latest release              | Copilot client version + proxy for `/models` schema |
| `CLAUDE_AGENT_USER_AGENT` — same file                               | `anthropics/claude-code` latest release                     | impersonated agent version                          |
| `OPENCODE_VERSION` — same file                                      | `sst/opencode` latest release                               | impersonated client version                         |
| `anthropicSdkStatsSha` — `scripts/ops/external-drift-baseline.json` | `anthropics/anthropic-sdk-typescript` `.stats.yml` blob SHA | `/v1/messages` OpenAPI-spec change                  |

The runtime Copilot `/models` **values** sit behind an authed token with no
public mirror, so the watcher does not call that endpoint. A `/models` _schema_
change only ships when the Copilot client changes, which the `copilotChat`
release watch already catches — diff the live schema locally with your own
credentials when it fires.

## How it reacts (no human in the loop)

`.github/workflows/watch-external-drift.yml` runs daily. It **detects and files
an issue — it never opens a PR**:

- **Any drift** (a version pin fell behind, the Anthropic spec hash moved, or a
  check failed) → files/refreshes one idempotent `external-drift`-labelled
  issue. The body is scoped so a reconciliation PR can be derived from it
  directly: the exact file to change, current pin, target version, an
  upstream-review link, and the acceptance step.
- **Clean run** → closes a stale drift issue.

**Why issue-only, not auto-PR.** Deriving and landing a PR from a well-formed
issue is `repoman`'s job (the repo's triage / merge-queue agent). Issue triage
is wired in `.github/workflows/triage.yml`, a thin caller that delegates every
issue event to repoman's `triage-reusable.yml@v1` — so the watcher hands off a
detailed, PR-derivable issue rather than duplicating that job with a narrower,
blind pin rewrite. Note the drift issue is created with `github.token`, which
by design fires **no** `issues.opened` event, so `triage.yml` never runs on it;
repoman's poll backstop picks it up instead (see below), so drift never goes
silently unhandled. Bumping an impersonated client version can shift proxy
behaviour, so reviewing the upstream release _before_ the pin moves is the
correct gate. This also keeps the watcher off the require-PR ruleset path
entirely: filing an issue needs only a plain `GITHUB_TOKEN` with `issues: write`
— no app-token, and none of the "a bot-authored PR won't trigger CI" fragility
that an auto-PR path would have to manage.

## How triage is wired

`.github/workflows/triage.yml` is a thin caller stub. On every `issues`
event (`opened`, `edited`, `reopened`) it delegates to repoman's shared
`stuffbucket/repoman/.github/workflows/triage-reusable.yml@v1`, which
auto-applies `needs-triage` (with an explainer comment) to any issue lacking
`needs-bot`/`needs-triage`. This mirrors the shape every repoman-managed repo
ships; `@v1` is a floating major tag that repoman dogfoods via a local ref
before propagating it to external callers.

Two paths cover triage, and the drift watcher relies on the second:

- **Event path** — `triage.yml`, for human-filed issues. The default
  `GITHUB_TOKEN` deliberately does not fire new workflow runs, so issues opened
  by a token-authored job (like this watcher's `external-drift` issue) never
  trigger it.
- **Poll backstop** — repoman's `poll.mjs` → `processMissedTriage`, scheduled
  every ~5 minutes across every managed repo (maximal is in repoman's
  `config/managed-repos.json`). It re-applies `needs-triage` to any open issue
  lacking **all** of {`needs-bot`, `needs-triage`, `repoman:internal`}, catching
  exactly the events the token-authored create above misses.

## Separation of concerns

- **Code:** `scripts/ops/watch-external-drift.ts` (alongside the other ops
  scripts). Pure Bun, deterministic.
- **Test:** `scripts/ops/watch-external-drift.test.ts`, colocated and kept out
  of the product `bun test` root. It is the **parity guard**: rename a pinned
  constant and `extractPin` reds the tooling CI before the watcher can report a
  bogus pin.
- **Tooling CI:** `.github/workflows/tooling-ci.yml` runs the colocated test on
  PRs that touch `scripts/ops/**`. The daily watcher also self-checks (runs the
  test) before it acts. The product's `ci.yml` never runs tooling tests.
- **Docs:** this file (`docs/admin/`), not `docs/architecture.md`.

## Reconciling a flag

repoman's issue-triage picks up the `external-drift` issue (via the poll
backstop — see *How triage is wired*) and derives the reconciliation PR; a
maintainer can also pick it up from the labelled issue by hand. Either way:

- **Version pin:** review the linked upstream release for behavioural changes,
  then bump the pin in `src/lib/config/api-config.ts` to the target version.
  Reconcile **every** occurrence — a version can also appear verbatim in a
  coupled User-Agent string (e.g. `OPENCODE_VERSION` is echoed in the opencode
  UA we send), so a search-and-replace on the bare value, reviewed before
  committing, is safer than touching only the pinned constant.
- **Anthropic spec hash:** review the SDK diff for new/changed message params,
  content blocks, or stream events; reconcile `src/lib/models/anthropic-types.ts`
  if needed; then bump `anthropicSdkStatsSha` in
  `scripts/ops/external-drift-baseline.json` in the same change. Current value:
  `gh api repos/anthropics/anthropic-sdk-typescript/contents/.stats.yml --jq .sha`

## Running locally

```sh
bun run watch:drift          # detect; writes a report if anything drifted
bun run test:ops             # the tooling test (scripts/ops/, its own bunfig)
```
