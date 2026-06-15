---
id: ADR-0006
title: Model AuthStatus as a discriminated union
status: accepted
date: 2026-06-14
accepted_date: 2026-06-15
authors:
  - stuffbucket
supersedes: []
depends_on:
  - docs/decisions/0005-share-settings-types-shell-proxy.md
links:
  shell_type: shell/src/api.ts
  shell_renderer: shell/src/main.ts
  backend_route: src/routes/settings/auth.ts
  controller: src/lib/auth-controller.ts
  implementation_commit: 1a2f1b71a639822e55b6e9df5042147e2f911994
---

# Model AuthStatus as a discriminated union

## Context

`AuthStatus` is declared as a single interface with five possible
`state` values and every other field optional:

```ts
interface AuthStatus {
  state: "unauthenticated" | "device_code_issued" | "polling"
       | "authenticated" | "error"
  user_code?: string
  verification_uri?: string
  expires_at?: string
  account_login?: string
  error?: string
  remediation_url?: string
  last_upstream_rejection?: { … }
}
```

Because every field is optional regardless of state, TypeScript
cannot enforce "if state==='device_code_issued' then user_code,
verification_uri, expires_at are present." The shell defends with
fallbacks scattered across `shell/src/main.ts`:

- `status.user_code ?? "…"` (line 579)
- `status.verification_uri ?? "https://github.com/login/device"` (line 583)
- `status.account_login ?? "(unknown)"` (line 588)
- `status.error ?? "Unknown error."` (line 595)
- `formatExpiresAt(iso ?? undefined)` returns `"soon"` when missing
- `accountKeyFor(state)` falls through to `"unauthenticated"` on any
  unknown value (line 396-402) — silently swallows new states

This is the root cause of the auth bugs that have eaten a month: each
sentinel hides a contract gap, and the gaps interact (the `(unknown)`
sentinel then has to be detected by `renderAccountAvatar()` to avoid
rendering `"("` as the user's initial).

## Decision

Model `AuthStatus` as a proper discriminated union:

```ts
export type AuthStatus =
  | { state: "unauthenticated"; last_upstream_rejection?: UpstreamRejection }
  | { state: "device_code_issued";
      user_code: string;
      verification_uri: string;
      expires_at: string }
  | { state: "polling";
      user_code: string;
      verification_uri: string;
      expires_at: string }
  | { state: "authenticated";
      account_login: string;
      account_host: string;
      last_upstream_rejection?: UpstreamRejection }
  | { state: "error";
      error: string;
      remediation_url?: string }

export interface UpstreamRejection {
  message: string
  status: number
  at: string
  remediation_url?: string
}
```

Co-requirements:

1. **Backend produces the right shape per state.** `auth-controller.ts`
   and `routes/settings/auth.ts` switch on `state` and construct the
   matching variant. If they can't (e.g. polling but no user_code
   somehow), that's a controller bug — fail loudly, don't ship `null`.
2. **`accountKeyFor()` becomes exhaustive.** Replace the
   fall-through-to-unauthenticated with a `switch` and a
   `const _exhaust: never = state` at the bottom so a new state
   added in the type fails to compile until the renderer handles it.
3. **`renderAccount()` becomes a discriminated dispatch.** TS narrows
   the union per case; no more `?? "(unknown)"` sentinels.
4. **The renderer-fallback bandage is removed.** Delete the
   `isPlaceholder = login === "(unknown)"` branch in
   `renderAccountAvatar()` — by contract, `authenticated` always has
   a real `account_login`. If GitHub omits one, the controller should
   surface an `error` state instead of a fake login.

## Implementation note (2026-06-15)

A first pass diverged from item 4 with a "best-effort" carve-out:
when `getGitHubUser` failed, the controller emitted
`account_login: "unknown"` and stayed in `state: "authenticated"`.
On review this was incoherent — the same path persisted an
`unknown@github.com` row to the account registry, which would
collide with the user's real account on the next successful
sign-in, and the UI would claim "Signed in as ?" forever — and
was reverted.

The shipped behavior matches the strict reading of item 4:

- `runPoller` treats a `getGitHubUser` failure as a sign-in failure.
  The token is dropped from in-memory state (never reaches
  `state.githubToken`), no row is added to `accounts.json`, and the
  controller transitions to `state: "error"` with the message
  "Couldn't verify your GitHub account. Try signing in again."
- `markSignedIn(login: string)` requires a real string (no `null`,
  no `"unknown"`). Cold-boot callers in `start.ts` resolve the
  login via `logUser()` first; if that didn't populate
  `state.userName`, the cold-boot path degrades to unauthenticated
  rather than claim signed-in under an unknown identity.
- The `signed-in` variant of the controller's internal `AuthState`
  union is `{ kind: "signed-in"; login: string }` — no nullable.
- The renderer's `login === "unknown"` placeholder branch is gone.
  The avatar only checks for an empty string (defense in depth for
  future variants); it never fires in practice.

UX trade-off accepted: a transient github.com hiccup during the
user-lookup round-trip will require the user to repeat the
device-code copy step. That's recoverable in seconds and far better
than the registry pollution + identity confusion the carve-out
created.

A `verifying` state with bounded retries (hold the token in memory,
poll `getGitHubUser` a few times before giving up) is the natural
extension if this turns out to fire often enough in practice to be
noisy. Defer until there's evidence — not speculation — that it
matters.

## Alternatives considered

- **Keep the loose shape; add zod validation at the boundary.** Still
  requires runtime fallbacks in the renderer because the static
  type stays optional. Doesn't push the safety into the compiler.
- **Promote `last_upstream_rejection` and `remediation_url` to
  top-level always-present sentinels (`null`).** Marginally better
  than `undefined` but doesn't capture the state-keyed invariants.
- **Make the shell more defensive.** Status quo. Reasoning that has
  not held up over five state additions.

## Consequences

- ADR-0005 (shared types) must land first so this refactor happens
  in one file.
- ADR-0004 (React-ify Account section) becomes substantially easier:
  the renderer matches over the union, and the test surface shrinks.
- One backend test per state asserts the controller produces the
  matching variant. Add `tests/auth-controller-shape.test.ts`.
- The `"unknown"` synthetic login sentinel is retired — the
  comment-as-spec ("substitutes when the proxy reports authenticated
  without a login") becomes "impossible by type."

## Migration

1. Add the new discriminated union next to the existing interface
   under `src/lib/settings-types.ts`.
2. Update `auth-controller.ts` and `routes/settings/auth.ts` to
   construct the matching variant per branch.
3. Update `shell/src/main.ts` `renderAccount()`, `accountKeyFor()`,
   and the slot writers to consume the union (the compiler will
   list every site).
4. Remove the now-dead sentinel branches.
5. Delete the old interface.

## Out of scope

- Multi-account fan-out (`AccountsListResponse` already models that
  separately; not part of `AuthStatus`).
- Persisted history of past rejections; `last_upstream_rejection` is
  still a single most-recent field.

## Open questions

- Should `device_code_issued` and `polling` collapse to one variant?
  Functionally the renderer treats them identically. The split lets
  the UI distinguish "we just got a code, user hasn't opened it" vs
  "we've sent at least one poll." If no UI cares, fold them into a
  single `"pending"` state and document the simplification.
- Should the union carry a discriminator for "post-error retry-able"
  vs "post-error needs-user-action"? Today `error` + `remediation_url`
  half-encodes this. Defer until the shell needs different chrome
  for the two cases.
