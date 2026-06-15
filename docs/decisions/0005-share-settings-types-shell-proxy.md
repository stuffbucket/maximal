---
id: ADR-0005
title: Share settings types between proxy routes and the Tauri shell
status: accepted
date: 2026-06-14
authors:
  - stuffbucket
supersedes: []
links:
  shell_api_client: shell/src/api.ts
  shared_types: src/lib/settings-types.ts
related_files:
  src/routes/settings/auth.ts: AuthStatus producer
  src/routes/settings/accounts.ts: AccountsListResponse producer
  src/routes/settings/apps.ts: AppEntry / AppConflict producer
  src/routes/settings/gh.ts: GhCliStatus producer
  src/routes/settings/api-keys.ts: ApiKeysListResponse producer
---

> **Implementation status (accepted, partially adopted).** The shell now
> imports the canonical types from `src/lib/settings-types.ts` instead of
> redeclaring them: `AuthStatus`, `UpstreamRejection`, `DiagnosticsResponse`,
> `ApiKeyEntry`, `ApiKeysListResponse`, and `AccountsListResponse`
> (`shell/src/api.ts`, `shell/src/main.ts`). This landed with the ADR-0006
> auth-status union and the ADR-0007 SSE work, which depend on a single
> source of truth for the wire shape.
>
> Still mirrored by-name in `shell/src/api.ts` pending migration:
> `GhCliStatus`, `ActiveApiClient` / `ActiveApiClientsResponse`, and
> `AppEntry` / `AppsListResponse`. These move over as each surface is next
> touched; the direction is settled.

# Share settings types between proxy routes and the Tauri shell

## Context

`shell/src/api.ts` defines `AuthStatus`, `GhCliStatus`, `AppEntry`,
`AppConflict`, `AppInstall`, `AppInstallHint`, and the
`accounts-list`/`accounts-switch`/`accounts-remove` response shapes as
**local copies** of types owned by the proxy. The file says so in
multiple comments:

> *Mirrors the contract owned by the proxy's `/settings/api/auth/github/*`
> endpoints. Kept in sync by name — if the backend renames a field,
> this breaks.* (line 38–40)
>
> *Kept LOCAL to this file on purpose — the backend's new `src/`
> settings-types are not present in this worktree, so importing them
> would break the typecheck. Mirror by name, not by import.* (line 126–129)

That second comment is now stale: `src/lib/settings-types.ts` exists
(247 lines), and `shell/src/api.ts` already imports
`AccountsListResponse`, `ApiKeyEntry`, `ApiKeysListResponse`, and
`DiagnosticsResponse` from it (line 27–32). So crossing the
shell↔proxy boundary in TypeScript is *already* working — only the
auth, gh-cli, apps, and accounts-mutation types are still mirrored.

The consequence is exactly the bug class the user spent a month on:
backend renames don't fail typecheck, they fail at runtime as
`undefined` reads in the shell. The recent `(unknown)` sentinel
substitution for `account_login` in `renderAccountAvatar()`
(`main.ts:425-430`) is a patch over this — the shell defensively
handles a missing field rather than the contract guaranteeing it.

## Decision

1. **Move every shell-visible response type into
   `src/lib/settings-types.ts`.** That includes `AuthStatus`,
   `GhCliStatus`, `GhUseResponse`, `AppEntry`, `AppId`, `AppKind`,
   `AppStatus`, `AppConflict`, `AppInstall`, `AppInstallHint`,
   `AppsListResponse`, `ActiveApiClient`, `ActiveApiClientsResponse`,
   `AccountSwitchResponse`, `AccountRemoveResponse`, and any others
   currently duplicated.
2. **Import them in `shell/src/api.ts`** instead of redeclaring.
   Delete the local copies.
3. **Have each route handler in `src/routes/settings/*.ts` annotate
   its response with the shared type** so the producer side is
   compile-checked. Example: `apps.ts` should return
   `AppsListResponse` explicitly, not an inferred object literal.
4. **Add `tests/settings-contract.test.ts`** that for each settings
   endpoint calls the route handler and asserts the shape via a
   small `zod` schema *or* via a structural type check
   (`satisfies AppsListResponse`). The point is to fail typecheck
   *and* tests if a producer drifts from the declared response type.

## Alternatives considered

- **Auto-generate types from OpenAPI / zod schemas.** Heavier; adds
  a code-gen step. The proxy's routes don't have an OpenAPI spec.
  Defer until there are external consumers; the shell+proxy live in
  one repo, direct imports suffice.
- **Use tRPC.** Replaces the HTTP contract entirely. Wrong altitude
  for this — the HTTP boundary is also the SDK boundary for users.
- **Leave shell types as duplicates with a doc-comment "keep in
  sync."** Status quo. The comments already exist and have not
  prevented drift.

## Consequences

- A backend field rename now fails `bun run typecheck` immediately
  at the shell. CI catches it before the runtime `undefined` does.
- `src/lib/settings-types.ts` becomes the *canonical* settings
  contract surface; the design docs can link to it as the source
  of truth for what each window can render.
- Sets up ADR-0006 (discriminated `AuthStatus`) — that refactor only
  has to happen in one place once this ADR lands.

## Migration

One PR. Order:

1. Move types into `src/lib/settings-types.ts` (additive).
2. Update `shell/src/api.ts` to import them; delete mirrors.
3. Annotate each route handler's return type.
4. Run `bun run typecheck` and `cd shell && bunx tsc --noEmit`; fix
   the drift the compiler surfaces.
5. Add the contract test.

## Out of scope

- Changing wire format (still JSON, same paths).
- Versioning the settings API. Single-version, in-tree; revisit only
  if a third consumer appears.

## Open questions

- Should the *request* bodies (`AccountSwitchRequest`, `GhUseRequest`)
  also move into `settings-types.ts`? Yes — symmetry is worth it, and
  the existing `Endpoint` discriminated union in `shell/src/api.ts`
  already carries `body` inline. Pull those out at the same time.
