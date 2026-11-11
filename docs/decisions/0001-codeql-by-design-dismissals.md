---
id: ADR-0001
title: CodeQL by-design dismissals
status: accepted
date: 2026-05-11
authors:
  - stuffbucket
links:
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

**Suppress by-design alerts with a standalone inline CodeQL comment
immediately before the sink**, keeping the rationale in ordinary comments:

```ts
const response = await fetch(url, {
  // By design: the proxy reads its own 0o600 token from disk and forwards it
  // as upstream Authorization. See ADR-0001.
  // codeql[js/file-access-to-http]
  headers: authHeaders(state),
})
```

`// codeql[<rule-id>]` (legacy alias `// lgtm[...]`) is CodeQL's native
in-source suppression, honored by the JavaScript/TypeScript analyzer. The
directive must stand alone on its line; rationale appended inside the
directive (e.g. `// codeql[rule] -- reason`) makes the current analyzer
ignore it. The directive sits immediately before the dataflow **sink**, while
the adjacent ordinary comment keeps the rationale greppable at the exact
point of concern.

The directive alone does not close the alert: the `security-extended`
analysis in `codeql.yml` still reports the result, and the alert stays open.
So each suppressed alert is also dismissed in the Security tab (*won't fix*,
or *used in tests* for test code) with a comment that gives the same
rationale and cites this ADR.

The current suppressed sites (grep `codeql\[` to enumerate):

| Rule | File | Why |
|---|---|---|
| `js/insufficient-password-hash` | `src/apps/claude-code/config.ts` | SHA-256 is an equality fingerprint for Maximal-owned helper configuration, not a password verifier |
| `js/file-access-to-http` | `src/lib/http/send-request.ts` | **Single mechanism** — every authenticated GitHub/Copilot/Anthropic/provider request funnels through it, and it attaches the disk-read token (see below) |
| `js/http-to-file-access` | `src/lib/auth/github-token-store.ts` | Persist OAuth token to 0o600 file |
| `js/http-to-file-access` | `scripts/sync-homebrew-formula.ts` | Release tooling renders a formula |
| `js/file-access-to-http` | `packages/figjam-layout/src/client.ts` | The opted-in pairing token, and layouts the operator passes as files, go only to the FigJam bridge: a fixed 127.0.0.1 host, a validated numeric port and no redirects |
| `js/file-access-to-http` | `packages/figjam-bridge/test/pairing.test.ts` | Test reads a throwaway bridge's admin token from its temp data directory |
| `js/client-side-request-forgery` | `packages/figjam-plugin/src/legacy/ui.html` | The panel fetches image URLs for the Figma sandbox; Figma enforces the manifest's `networkAccess` hosts as the iframe's CSP |

## One HTTP mechanism owns token attachment

`src/lib/http/send-request.ts` (`sendRequest` / `sendRequestJson` /
`sendProviderRequest`) is the only place a credential becomes a request
header:

1. **One sink.** Every authenticated request — Copilot completions,
   GitHub auth/discovery, OAuth device flow, direct Anthropic, and
   provider passthrough — funnels through one `fetch`. That is the only
   `js/file-access-to-http` suppression for the app, and new
   authenticated endpoints inherit it.
2. **The destination host determines the credential.** For the fixed
   first-party hosts (Copilot, GitHub API, direct Anthropic, and the
   unauthenticated GitHub OAuth endpoints) the caller passes only a URL
   and `attachHostAuth` maps host → token + scheme; there is no
   credential argument to get wrong. The config-selected passthrough
   provider (arbitrary base URL) instead passes its resolved
   `ResolvedProviderConfig` (host + key + scheme bundled) to
   `sendProviderRequest`. Either way the token becomes an `Authorization`
   / `x-api-key` header on a function-local `Headers` that is never
   returned, and the header builders in `src/lib/config/api-config.ts`
   are token-free. An unrecognized host gets no credential. Each
   credential reaches exactly one host; no host receives two credentials.
3. **The invariant is enforced.** The `credential-attachment-single-mechanism`
   ESLint rule in `eslint.config.js` fails CI if code outside the mechanism
   hand-builds a `Bearer …` / `token …` auth string or attaches an
   `x-api-key` property. That rule's `ignores` list is the authoritative
   set of reviewed exceptions, each with its reason.

# Consequences

- **A suppression cannot drift.** The comment is attached to the sink
  line itself; when the code moves, the comment moves with it. There is
  no external `file:line` registry to fall out of sync.
- **Few moving parts.** No reconcile script and no extra workflow. The
  one manual step is the Security-tab dismissal described above.
- **Reversing a suppression** is a one-line diff (delete the comment)
  plus reopening the dismissed alert.
- **A new alert on an un-annotated sink is real signal** — it surfaces
  in the Security tab and gets either a code fix or a reviewed inline
  suppression, in the same PR that introduces it.
- **Rule-wide exclusions are a different tool.** A `query-filters` /
  `paths-ignore` entry means "never run this query / scan this path,"
  never a substitute for a per-sink decision. `.github/codeql/codeql-config.yml`
  holds those (and the query suite); `codeql.yml` passes it via
  `config-file:`. Its `paths-ignore` also decides which changes trigger a
  scan at all (`scripts/codeql-languages.ts`).
