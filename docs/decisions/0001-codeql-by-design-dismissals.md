---
id: ADR-0001
title: CodeQL by-design dismissals
status: accepted
date: 2026-05-11
authors:
  - stuffbucket
links:
  codeql_config: .github/codeql/codeql-config.yml
  issue: https://github.com/stuffbucket/maximal/issues/9
codeql_dismissals:
  - rule: js/file-access-to-http
    path: src/services/copilot/create-embeddings.ts
    line: 10
    reason: "won't fix"
    rationale: >
      Proxy authenticates upstream by reading its own 0o600 token from
      ~/.local/share/copilot-api/ and forwarding it as Authorization:
      Bearer. Same posture as gh/aws/kubectl. This is the proxy's sole
      reason to exist.
  - rule: js/file-access-to-http
    path: src/services/copilot/get-models.ts
    line: 10
    reason: "won't fix"
    rationale: >
      Proxy authenticates upstream by reading its own 0o600 token from
      ~/.local/share/copilot-api/ and forwarding it as Authorization:
      Bearer. Same posture as gh/aws/kubectl. This is the proxy's sole
      reason to exist.
  - rule: js/file-access-to-http
    path: src/services/github/get-user.ts
    line: 13
    reason: "won't fix"
    rationale: >
      Proxy authenticates upstream by reading its own 0o600 token from
      ~/.local/share/copilot-api/ and forwarding it as Authorization:
      Bearer. Same posture as gh/aws/kubectl. This is the proxy's sole
      reason to exist.
  - rule: js/file-access-to-http
    path: src/services/github/get-device-code.ts
    line: 10
    reason: "won't fix"
    rationale: >
      Proxy authenticates upstream by reading its own 0o600 token from
      ~/.local/share/copilot-api/ and forwarding it as Authorization:
      Bearer. Same posture as gh/aws/kubectl. This is the proxy's sole
      reason to exist.
  - rule: js/file-access-to-http
    path: src/services/github/poll-access-token.ts
    line: 44
    reason: "won't fix"
    rationale: >
      Proxy authenticates upstream by reading its own 0o600 token from
      ~/.local/share/copilot-api/ and forwarding it as Authorization:
      Bearer. Same posture as gh/aws/kubectl. This is the proxy's sole
      reason to exist.
  - rule: js/file-access-to-http
    path: scripts/gemma-watch.ts
    line: 102
    reason: "won't fix"
    rationale: >
      Dev-only watcher, not shipped, not on the runtime path. Reads
      local model state from disk and posts to a local Ollama instance.
  - rule: js/http-to-file-access
    path: src/lib/github-token-store.ts
    line: 101
    reason: "won't fix"
    rationale: >
      writeGitHubTokenRecord persists the OAuth token we just received
      to ~/.local/share/copilot-api/github-token at mode 0600. That is
      the function's job — same model as `gh auth login`.
  - rule: js/http-to-file-access
    path: scripts/sync-homebrew-formula.ts
    line: 166
    reason: "won't fix"
    rationale: >
      Release tooling renders a Homebrew formula. Source is a GitHub
      release SHA from the API; output path is a CLI arg controlled by
      the maintainer. Not on the runtime path.
---

# Context

GitHub's Security tab records who dismissed each CodeQL alert with what
reason, but the rationale is per-alert and not greppable. Issue #9 was
resolved via 8 `gh api PATCH` calls; the rationale ended up in 8
separate dismissal comments and a now-closed issue. Six months from
now, "why is `js/file-access-to-http` dismissed on `get-user.ts`?"
requires clicking through the security UI.

ADRs are the standard dev pattern for "decision durable enough to
survive a UI change." Adding structured `codeql_dismissals` frontmatter
lets us cross-reference dismissals two ways: the Security tab UI for
auditors, and `grep` in the repo for engineers.

# Decision

Dismiss the alerts listed in `codeql_dismissals` as `won't fix`. The
rationale lives in the frontmatter so it survives UI changes, repo
moves, and account churn.

A reconcile script (`scripts/reconcile-codeql.ts`) reads every ADR
under `docs/decisions/`, unions the `codeql_dismissals` arrays, and
walks the live CodeQL alert state to enforce that union: matching open
alerts get dismissed with the ADR's reason; dismissed alerts not
covered by any ADR get re-opened. The script runs on push to `main`
whenever an ADR (or the workflow itself) changes, and on
`workflow_dispatch`.

# Consequences

- The Security tab will not show these eight alerts as open. A new
  alert on the same rule + a *new* path is real signal that needs its
  own ADR entry (or a code fix).
- Reversing a dismissal is a PR: delete the ADR entry, merge, and the
  next workflow run re-opens the alert.
- The reconcile script needs `security-events: write`. That permission
  is already granted to the existing `codeql.yml` workflow; the new
  `codeql-reconcile.yml` reuses it.
- Adding an ADR entry for an alert that does not exist in the API is a
  no-op (the script logs a warning). This is deliberate: stale ADR
  entries are cheaper to spot than missing ones.
