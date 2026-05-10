# Phase 7 — opencode-as-client efficiency

## 30-second context

opencode (AI coding agent at `anomalyco/opencode`) can use maximal as its
inference backend. Today it works only when `COPILOT_API_OAUTH_APP=opencode`
is set in maximal's env, and it duplicates state opencode itself already
holds (auth tokens, UA strings). This phase removes the env-var dependency
and reuses opencode's on-disk state so the first-run experience is
"install maximal, point opencode at it, done."

This is orthogonal to Phases 1-6 (CI, build, test, auth, distribution,
self-update). Picks up the loose ends from the auth research surfaced
during Phase 4 about runtime token-prefix detection.

## Goals

1. A single maximal install serves Claude Desktop (`ghu_`) and opencode
   (`gho_`) clients concurrently on one port. No env-var dance, no
   per-client install.
2. opencode users get working maximal without re-running device-code if
   they're already authenticated to opencode on the same machine.
3. opencode's User-Agent reaches GitHub's edge verbatim — we don't lag
   their allowlist signal by hardcoding a version string in maximal.
4. `/v1/models` returns the set of models that actually work for the
   token currently in flight, not a static union.

## Non-goals

- Replacing maximal's default identity. `Iv1.b507a08c87ecfe98` ("GitHub
  Copilot Chat") remains the default; opencode mode is auto-detected,
  not the new default.
- Bidirectional sync. We read opencode's token if available, never write
  back to it. opencode's auth file stays opencode-owned.
- A new wire protocol or admin endpoint. Behaviour switches happen
  silently per-request based on the inbound signals.

## Design

### 7.1 Per-request mode detection

`isOpencodeOauthApp()` becomes a fallback for *startup* configuration,
not a per-request branch. New helper `getRequestMode(c)` returns
`"opencode" | "default"` based on, in order:

1. Inbound `User-Agent` matches `^opencode/[\d.]+`. Strongest signal —
   the actual opencode binary is talking.
2. The bearer token used to authenticate the *request to maximal* (when
   the proxy itself is auth-gated) starts with `gho_`. Less strong but
   useful for non-opencode clients reusing opencode's token.
3. Otherwise → `"default"`.

Every branch in `src/lib/api-config.ts` that today reads
`isOpencodeOauthApp()` (~10 sites) accepts the result of `getRequestMode`
instead. Branches that depend on outbound token type (where `gho_` is the
relevant signal) read it from `state.copilotToken` prefix.

### 7.2 User-Agent passthrough

`OPENCODE_VERSION` and `OPENCODE_LLM_USER_AGENT` constants in
`api-config.ts` become fallbacks. The forwarding logic captures the
inbound request's `user-agent` header; if it matches `^opencode/`, that
exact string forwards to Copilot. Only when no opencode-shaped UA is
present do we synthesize one from the constants.

The synthesized fallback bumps to "opencode/<latest known good>" — but
that "latest" lives in a single place (`OPENCODE_VERSION`) and a small
nightly CI job (Phase 1's nightly-smoke pattern) probes the
`anomalyco/opencode` releases API for drift. Failure → opens an issue.

### 7.3 Token sharing with opencode's on-disk auth

opencode persists its tokens at `~/.local/share/opencode/auth.json` on
macOS/Linux and `%APPDATA%\opencode\auth.json` on Windows (verify the
exact path by reading
[opencode's source](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/auth/storage.ts)
before implementing).

New helper `tryReadOpencodeToken()`:

1. If maximal already has a valid token on disk, return null (we don't
   override). Maximal's record wins.
2. Else, read the opencode auth file. If missing/unparseable, return null.
3. Else, extract the GitHub token (likely under `github.refresh` per the
   research notes). Wrap in maximal's `GitHubTokenRecord` shape with
   `tokenType: "gho_"` and write it via `writeDefaultRecord`.
4. Log: "Reused existing opencode auth — no device-code flow needed."

Called once during `setupGitHubToken({ force: false })` *before* the
device-code flow. Strictly additive: maximal users untouched, opencode
users skip device-code.

The opencode-side token is not modified. If opencode rotates it later,
maximal's cached copy will start failing; the existing refresh logic
(or a 401 from upstream) re-reads opencode's file before re-doing
device-code.

### 7.4 Per-token model filtering

`src/routes/models/route.ts` currently returns a static list. Make it
filter based on `state.copilotToken`'s prefix:

- `ghu_` → full ghu-allowlist set (current behavior).
- `gho_` → reduced gho-allowlist set.

The reduced set is empirically determined: at first use of a `gho_`
token, probe each model with a 1-token request and cache the success/
failure for the lifetime of that token. Cache invalidates on token
rotation.

For unattended robustness, ship a hardcoded "known to work with `gho_`"
allowlist as the initial filter; the empirical probe upgrades it
asynchronously after first use.

### 7.5 Behavior matrix (acceptance documentation)

| Inbound client | Inbound UA | Token on disk | Result |
|---|---|---|---|
| Claude Desktop | `Claude/…` | `ghu_` | default mode, full model list, refresh loop runs |
| opencode | `opencode/1.14.29` | `gho_` | opencode mode, filtered model list, no refresh |
| opencode (unauth'd maximal) | `opencode/1.14.29` | none | opencode mode, reads opencode's auth.json, writes a `gho_` record, proceeds |
| Custom CLI | unset | `ghu_` | default mode, full model list |
| `gho_`-token user without opencode UA | unset | `gho_` | opencode mode (token-prefix fallback), filtered list |

## Acceptance

- `bun test` passes a new test matrix that exercises the table above.
- A user running `opencode` with `MAXIMAL_BASE=http://127.0.0.1:4141`
  exported (or however opencode points at gateways) gets responses
  through maximal without setting `COPILOT_API_OAUTH_APP=opencode`.
- A user running both Claude Desktop and opencode against the same
  maximal sees correct responses for each — Claude Desktop's GHU-only
  models load for it, opencode's GHO-allowlist applies to its requests.
- A fresh maximal install on a machine where opencode is already
  authenticated does not trigger a second device-code flow.
- `maximal debug` reports the request-mode detection signals (UA seen,
  token prefix loaded) so users can self-diagnose.

## Estimate

3 days total:
- 0.5d — refactor `isOpencodeOauthApp()` call sites to per-request mode.
- 0.5d — UA passthrough.
- 1d — opencode token import (includes verifying opencode's on-disk
  schema and writing a defensive parser).
- 0.5d — model-list filtering (with hardcoded allowlist; empirical
  probe deferred).
- 0.5d — tests + `maximal debug` surface.

## Open questions

1. opencode's auth.json schema — confirm shape against current opencode
   main before locking the parser. If the field names move, our reader
   needs to be tolerant or version-gated.
2. Do we want a `--prefer-opencode-auth` flag for users who have *both*
   ghu_ and gho_ tokens and want to favour opencode's? Defer until
   someone asks.
3. Concurrent ghu_ + gho_ requests sharing one maximal — does the
   refresh loop's lifetime need to be per-token instead of global?
   Today it's a single AbortController; might need a small map keyed
   on token prefix. Spike during 7.1 implementation; if non-trivial,
   split into Phase 7b.
4. Empirical model probing (7.4) — does GitHub rate-limit
   model-availability probes? Probably yes. Cache aggressively, run on
   token-load not per-request.
