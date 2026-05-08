# Phase 4 — Auth UX (enhanced device-code)

## 30-second context

Improve first-run authentication UX without changing our OAuth identity.
Maximal is a Copilot-shaped proxy: downstream tools (Claude Desktop, Claude
Code, gh-copilot, etc.) talk to maximal expecting GitHub Copilot semantics.
The right posture is to **appear to be GitHub Copilot to GitHub** — i.e.,
keep using Microsoft's `Iv1.b507a08c87ecfe98` ("GitHub Copilot Chat")
GitHub App, the same one Cursor, opencode, copilot.vim, avante.nvim, and
LiteLLM all use.

Earlier drafts of this PRD considered registering our own
`stuffbucket-maximal` OAuth/GitHub App and using a true loopback OAuth
flow with embedded `client_secret`. After investigation those approaches
were rejected; this PRD captures what we *will* do, with the rejection
analysis preserved for future readers.

## Why we're not registering our own App

1. **Per-client_id Copilot allowlist.** GitHub maintains server-side
   allowlists keyed on client_id that govern which Copilot models and
   endpoints respond. Registering our own App lands us on a more
   restrictive allowlist; opencode's
   [issue #20759](https://github.com/anomalyco/opencode/issues/20759)
   documents the consequences (Copilot Business/Enterprise users break,
   model availability diverges). The opencode maintainer explicitly
   notes: "every working third-party Copilot tool uses VS Code's client
   ID."
2. **Authorization fatigue.** A separate App means a separate "Authorized
   GitHub Apps" entry on github.com. Users would approve `Cursor`,
   `Claude Code`, `opencode`, AND `stuffbucket-maximal` independently —
   yet all four do the same thing (Copilot proxy). Riding on the shared
   `Iv1.b507a08c87ecfe98` authorization is one prompt instead of N.
3. **Internal-MS audience.** Most of our distribution targets have
   Copilot Business subscriptions. Allowlist risk is acutely real here.

## Why we're not doing loopback OAuth

We don't have Microsoft's `client_secret` for `Iv1.b507a08c87ecfe98`. The
GitHub authorize endpoint accepts loopback redirect_uri values for the
App, but the code-exchange step requires the secret per
[GitHub's docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).
PKCE doesn't waive that requirement. Owning the secret would mean owning
the App, which lands us in §"Why we're not registering our own App."

## Goals

1. First-run authentication is one click in the browser, not a five-step
   copy/paste dance.
2. Subsequent re-auths are no-ops (token caching is already in place;
   verify it stays correct).
3. Apply the small, safe improvements observed from opencode's flow:
   runtime token-prefix detection, RFC 8628 `slow_down` handling,
   skipping the refresh loop for non-expiring `gho_` tokens.

## Non-goals

- Registering our own GitHub App / OAuth App.
- Loopback OAuth.
- Custom URI schemes (`maximal://`). Tracked separately as a Phase-7
  candidate for deep-linking, *not* auth.
- A tray companion. Phase 7 territory.

## Design

### 4.1 Enhanced device-code UX

Current behavior: `maximal setup` prints a code and a URL; user copies the
code, opens the URL in a browser, pastes the code, approves.

New behavior:

1. Call `getDeviceCode()` as today against `Iv1.b507a08c87ecfe98`.
2. **Auto-open** `https://github.com/login/device?user_code=XXXX-XXXX` in
   the user's default browser via `Bun.spawn`:
   - macOS: `["open", url]`
   - Windows: `["cmd", "/c", "start", "", url]`
   - Linux: `["xdg-open", url]`
3. Print a fallback message (in case the spawn fails or there's no
   browser): "If your browser didn't open, visit
   https://github.com/login/device?user_code=XXXX-XXXX"
4. Poll `/login/oauth/access_token` as today, honoring `slow_down`
   (see §4.3).

UX result: user clicks the terminal-printed link or sees the browser pop
open with the code already filled in. They click "Authorize Copilot
Chat" — same prompt every other Copilot tool produces. Done.

### 4.2 Headless / SSH opt-out

Add `maximal setup --device-code` (alias `--no-browser`) that prints the
URL+code without trying to spawn a browser. Auto-detect headless: if
`process.env.DISPLAY` is unset on Linux, fall back to no-browser mode
without requiring the flag.

### 4.3 RFC 8628 polling correctness

Audit `src/services/github/poll-access-token.ts`. Per
[RFC 8628 §3.5](https://datatracker.ietf.org/doc/html/rfc8628#section-3.5),
when GitHub responds with `slow_down`, the client must increase its poll
interval by at least 5 seconds. If we currently use a fixed interval,
fix it to honor the server's bump.

### 4.4 Runtime token-type detection

Replace the `COPILOT_API_OAUTH_APP=opencode` env-flag branch in
`src/lib/token.ts:33` with a runtime prefix check on the persisted token:

- Token starts with `gho_` (OAuth App token, opencode-style) →
  use directly as Copilot bearer; **skip refresh loop** (these tokens
  don't expire).
- Token starts with `ghu_` (GitHub App user-to-server token, our default)
  → exchange via `/copilot_internal/v2/token`, run the existing refresh
  loop.

Same logic, less env-coupling. Removes one configuration knob.

### 4.5 No re-auth when a valid token exists

Already implemented — `setupGitHubToken({ force: false })` early-exits
when a token is on disk and validates via `getGitHubUser()`. **Verify**
the existing token revalidation path doesn't unnecessarily call
`getCopilotToken()` on every `maximal start`. If it does, cache the
Copilot bearer's expiry and only refresh when `Date.now() > expiry -
buffer`.

### 4.6 Token storage shape

Today's `${COPILOT_API_HOME}/<oauth-app>/github_token` contains the bare
token string. Promote to JSON with schema versioning so future changes
(refresh-token rotation if we ever switch flows, multi-account, expiry
caching) don't require a parse-rewrite migration:

```jsonc
{
  "schemaVersion": 1,
  "tokenType": "ghu_",            // or gho_
  "accessToken": "ghu_xxxx",
  "refreshToken": null,           // populated only for ghu_ when applicable
  "obtainedAt": "2026-05-08T00:00:00Z"
}
```

Backwards-compat: if the file is a bare token string (no JSON), wrap it
into the v1 shape on first read and rewrite atomically.

## Acceptance

- Running `maximal setup` on a desktop with a default browser opens
  `https://github.com/login/device?user_code=XXXX-XXXX` in that
  browser. The user-code field on the page is pre-filled. User clicks
  "Authorize," returns to terminal, sees "Logged in as `<user>`."
- Running `maximal setup` over SSH (no DISPLAY) prints the URL+code
  without trying to spawn a browser. Same result after manual paste.
- A `gho_` token on disk (left by opencode-style auth) drives Copilot
  requests directly — no refresh loop, no `/copilot_internal/v2/token`
  exchange. `bun test` covers both branches.
- A `ghu_` token on disk drives the existing refresh + exchange path.
  No regressions in current 239 tests.
- Receiving `slow_down` from GitHub during device-code polling delays the
  next poll by ≥5 seconds. Covered by a new test using a fetch mock.
- A user who already has a valid token and re-runs `maximal setup` does
  not see a new authorization prompt. The existing token is reused.

## Estimate

Half a day for browser-spawn + headless detection (4.1, 4.2). Half a day
for poll correctness + runtime prefix detection + storage shape
(4.3-4.6). One day total. No new dependencies. No GitHub App registration.
No new repo secrets.

## Open questions

1. Do we want a `maximal logout` subcommand to delete the token? Today
   `uninstall --purge` covers it; a dedicated logout might be friendlier.
   Defer to user request.
2. Multi-account support (e.g., user has Copilot via two GitHub
   identities)? Out of scope for v1; the JSON shape leaves room.
3. Do we ever want to add an OPT-IN `--our-own-app` mode where users who
   know they're on personal Copilot (not Business) can take a maximal-
   owned client_id? Could enable runtime experiments without breaking
   the default. Possible Phase 4.5 if anyone asks.
