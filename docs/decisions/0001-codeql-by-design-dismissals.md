---
id: ADR-0001
title: CodeQL by-design dismissals
status: accepted
date: 2026-05-11
amended: 2026-07-03
authors:
  - stuffbucket
links:
  codeql_config: .github/codeql/codeql-config.yml
  issue: https://github.com/stuffbucket/maximal/issues/9
---

# Context

A handful of CodeQL alerts are by-design for this project: it is an
auth-forwarding proxy, so reading a local token file and sending it to
an upstream over HTTP (`js/file-access-to-http`), and persisting a
freshly-received token back to a 0o600 file (`js/http-to-file-access`),
are exactly what the proxy exists to do. These are decisions with
rationale, not bugs to fix.

GitHub's Security tab records who dismissed each alert with what reason,
but the rationale is per-alert and not greppable. We want the "why" to
live in the repo, next to the code, surviving UI changes and account
churn.

# Decision

**Suppress by-design alerts with an inline CodeQL comment on the sink
line**, carrying the rationale inline:

```ts
const response = await fetch(url, {
  // codeql[js/file-access-to-http] -- by design: the proxy reads its own
  // 0o600 token from disk and forwards it as upstream Authorization. See ADR-0001.
  headers: authHeaders(state),
})
```

`// codeql[<rule-id>] -- <reason>` (legacy alias `// lgtm[...]`) is
CodeQL's native in-source suppression, honored by the JavaScript/
TypeScript analyzer. CodeQL emits it as a SARIF `suppressions` entry
with `@kind: IN_SOURCE`; GitHub code scanning then shows the alert as
resolved. The comment sits on the dataflow **sink** line, so it moves
with the code and the rationale is greppable at the exact point of
concern.

The current suppressed sites (grep `codeql\[` to enumerate):

| Rule | File | Why |
|---|---|---|
| `js/file-access-to-http` | `src/lib/send-request.ts` | **Single mechanism** — every authenticated GitHub/Copilot/provider request funnels through `sendRequest`, which attaches the disk-read token and forwards it upstream |
| `js/file-access-to-http` | `scripts/gemma-watch.ts` | Dev-only watcher → local Ollama |
| `js/http-to-file-access` | `src/lib/github-token-store.ts` | Persist OAuth token to 0o600 file |
| `js/http-to-file-access` | `scripts/sync-homebrew-formula.ts` | Release tooling renders a formula |

The six per-service `src/services/{copilot,github}/*` suppressions were
collapsed into the single `send-request.ts` mechanism (see the token-
ownership amendment below): callers name a credential domain but never
build the auth header, so the file→HTTP sink they all route through
lives in one place and the taint terminates at one annotated line. New
authenticated endpoints inherit the suppression for free.

# Consequences

- **A suppression cannot drift.** The comment is attached to the sink
  line itself; when the code moves, the comment moves with it. There is
  no external `file:line` registry to fall out of sync.
- **No moving parts.** No reconcile script, no extra workflow, no
  `security-events: write` API writes, nothing to crash. The single
  `codeql.yml` analysis honors the comments directly.
- **Reversing a suppression is a one-line diff:** delete the comment.
  The next analysis re-opens the alert.
- **A new alert on an un-annotated sink is real signal** — it surfaces
  in the Security tab and gets either a code fix or a reviewed inline
  suppression, in the same PR that introduces it.
- **Rule-wide exclusions still belong in `query-filters`** in
  `.github/codeql/codeql-config.yml` — but only when we mean "never run
  this query," never as a substitute for a per-sink decision.

# Amendment (2026-07-03): superseded the reconcile-daemon approach

This ADR originally expressed the same decisions as `codeql_dismissals`
YAML frontmatter, enforced by a `scripts/reconcile-codeql.ts` daemon
(workflow `codeql-reconcile.yml`) that walked the live alert API and
dismissed/re-opened alerts to match the frontmatter.

That approach keyed each suppression on `file:line` in a registry stored
*outside* the source. Line numbers are the most volatile coordinate a
sink has, so ordinary edits above a sink silently broke the link: the
old dismissal stayed frozen on the old line while CodeQL opened a fresh
alert on the new line, and the reconcile pass — which only ever checked
*dismissed* alerts — reported "in sync" while live alerts sat open. A
separate bug in the re-open path (sending `dismissed_reason: null` with
`state: "open"`) also 422'd and crashed the workflow (fixed in #195).

Inline suppression removes the external key entirely and lets CodeQL's
own analysis do the drift-tracking it is built for, which serves this
ADR's original goal — greppable rationale that survives change — more
simply and more robustly. The frontmatter registry, the reconcile
script, and the `codeql-reconcile.yml` workflow are removed.

# Amendment (2026-07-03): one HTTP mechanism owns token attachment

The six per-service inline suppressions were themselves a symptom: the
authenticated `fetch` call — and the `Authorization` header — was
duplicated across ~13 sites in `src/services/{copilot,github}/*` (plus a
second, un-suppressed sink in `anthropic-proxy.ts`). CodeQL flagged each
because each was a distinct file→HTTP sink.

We collapsed them into a single mechanism, `src/lib/send-request.ts`
(`sendRequest` / `sendRequestJson`), with three properties:

1. **One sink.** Every authenticated request — Copilot completions,
   GitHub auth/discovery, OAuth device flow, and provider passthrough —
   funnels through the one `fetch` in `sendRequest`. That is the only
   `js/file-access-to-http` suppression for the app.
2. **The mechanism owns token selection + attachment.** Callers pass a
   `Credential` (`{ domain: "copilot" | "github" | "provider" | "none" }`)
   and only non-secret request headers. The token is read and turned into
   an `Authorization` / `x-api-key` header inside the module-private
   `attachAuth`, on a function-local `Headers` that is never returned. The
   header builders in `api-config.ts` were stripped of their `Authorization`
   lines and are now token-free — a caller cannot obtain the token or the
   finalized request.
3. **The invariant is enforced, not just documented.** An ESLint
   `no-restricted-syntax` rule (`eslint.config.js`,
   `credential-attachment-single-mechanism`) fails CI if any file outside
   `send-request.ts` hand-builds a `Bearer …` / `token …` auth string. A
   new endpoint that tries to attach its own token cannot merge; it must
   route through the mechanism. (`web-tools/executor.ts` forwards a
   separate sandbox key and is allowlisted pending a follow-up.)

Least-privilege routing (each credential reaches exactly one host; no
host receives two credentials) was already true and is preserved — the
mechanism centralizes it rather than changing it.

Out of scope / follow-ups: the authenticated `/token` endpoint
(`routes/token/route.ts`) still returns the Copilot token to the shell by
design (it is behind API-key auth, not unauthenticated); the web-tools
executor's sandbox credential is not yet a `Credential` domain.
