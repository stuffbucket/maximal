---
id: ADR-0011
title: Cross-file module-mock leakage discipline (prefer DI over mock.module)
status: proposed
date: 2026-06-14
authors:
  - stuffbucket
supersedes: []
links:
  architecture_doc: docs/architecture.md
related_files:
  tests/: 80+ test files
  tests/helpers/: shared test fixtures
---

# Cross-file module-mock leakage discipline (prefer DI over `mock.module`)

## Context

`docs/architecture.md` § *Testing gotchas* documents the issue:

> *`mock.module` persists forward across files in a run.* Bun does
> not reset module mocks between test files, and CI orders files
> differently than local. A mock wrapper that drops arguments
> (e.g. forwards only the first param) will corrupt a *sibling*
> file's tests that pass the dropped args — and it'll pass locally
> but fail in CI. Make wrappers behaviorally identical to the real
> module (forward `...rest`), or prefer injectable function options
> over `mock.module`. This bit us twice on the apps work.

The two bites both manifested as: green PR locally, red CI, and the
failing test was *not* the test that installed the bad mock — it was
a downstream file that happened to be ordered after it. Root-causing
took hours each time because the failure surface and the cause are
in different files.

Today there is no enforcement; the guidance lives only in prose, and
the codebase has grown to 80+ test files. Each new contributor
discovers the rule by violating it.

## Decision

Three layers of defense:

1. **Convention: prefer injectable function options over
   `mock.module` for any module another test might import.** Pure
   functions accept dependencies as optional parameters with real
   defaults; tests pass mocks explicitly.

   ```ts
   // Preferred
   export function detectClaudeCode(
     opts: { readFile?: typeof fs.readFile, exec?: typeof execFile } = {},
   ): Promise<ClaudeCodeInstall[]> {
     const readFile = opts.readFile ?? fs.readFile
     // …
   }

   // In test
   await detectClaudeCode({ readFile: stubReadFile })
   ```

2. **Allowlist for `mock.module`.** Only permitted in
   `tests/helpers/` for shared test scaffolding, or in single-file
   tests of modules that nothing else imports. Add an ESLint rule
   (custom or `no-restricted-syntax`) that forbids
   `mock.module(...)` outside the allowlist; CI fails on violation.

3. **Wrapper rule (when `mock.module` is genuinely necessary):
   forward `...rest` and preserve return shapes.** The rule is in
   prose today; add a lint message that surfaces it on every
   `mock.module(...)` allowed by the allowlist:

   ```
   /* eslint-disable no-restricted-syntax --
      mock.module here is allowed because <reason>.
      MUST forward ...rest and preserve return shape.
      See ADR-0011. */
   ```

   The disable comment forces the author to state the reason and
   makes the wrapper rule unmissable.

## Alternatives considered

- **Switch test runner.** Vitest has scoped module mocks. Big
  blast radius; we'd lose Bun's speed and the existing test
  fixtures. Not worth the migration for this issue alone.
- **Process-per-file test runs.** Run `bun test <file>` in a
  subprocess per file from a wrapper script. Eliminates leakage by
  construction; slows the suite. Acceptable fallback if the lint
  rule proves leaky in practice.
- **Status quo (prose only).** Has bitten twice; will bite again.

## Consequences

- New code defaults to DI; existing `mock.module` sites get audited
  and either moved to DI or wrapped with the allowlist comment.
- One PR per high-traffic mock to migrate (recommend starting with
  whatever `apps` tests still use, since architecture.md flags
  those as the recurring victims).
- The lint rule + comment makes the failure-mode learnable in
  review rather than in CI red.

## Migration

1. Add the ESLint `no-restricted-syntax` rule for `mock.module`
   call expressions; configure messages.
2. Allowlist `tests/helpers/**` and any single-file usage.
3. Run lint; for each violation: either inline-disable with the
   ADR-0011 comment + reason, or refactor to DI.
4. Update `docs/architecture.md` to point at this ADR rather than
   carrying the entire gotcha in prose.
5. Update `tests/helpers/README.md` (create if absent) describing
   the DI pattern and the disable-comment template.

## Out of scope

- Mutation testing strategy (covered separately by
  `stryker.conf.json` and the architecture doc's second testing
  gotcha — "green tests can still test nothing").
- Test runner change.

## Open questions

- Is there *any* case where `mock.module` is the only option?
  Yes — modules that internally import `node:fs` and don't accept
  injection, when the call site is deep. Document the escape
  hatch (the inline-disable + wrapper rule) and resist the urge
  to make it the default.
- Should the rule extend to `mock(...)` (bun's per-test variable
  mock)? That's per-test and scoped; the rule applies only to
  `mock.module`, which is module-graph-level.
