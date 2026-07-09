# Testing Strategy — maximal

**Status:** Living document, prepared for external review.
**Last updated:** 2026-07-03.
**Audience:** professional software-testing reviewers, plus contributors who
need one place that describes how this project verifies itself.

This document consolidates the project's testing process: what we test, how,
with what tooling, where the gates are, what we deliberately *don't* do, and
the known weaknesses we want a review to pressure-test. It describes the system
**as it actually is today**, and flags aspirational items explicitly as such.

For the terse in-repo pointers this expands on, see
[`docs/architecture.md` → *Testing gotchas*](../architecture.md) and the
project root [`CLAUDE.md`](../../CLAUDE.md).

---

## 1. What this project is (context for the test strategy)

`maximal` is a local HTTP proxy that presents an Anthropic-compatible API
(`/v1/messages`, `/chat/completions`, `/responses`, `/models`, `/embeddings`)
and brokers requests to GitHub Copilot's backend (Bedrock-hosted Claude and
GPT models), translating protocols, rewriting payloads, and managing auth. It
ships as:

- a **CLI / standalone binary** (the proxy itself), and
- a **Tauri 2 menu-bar app** (`shell/`) that wraps the proxy as a sidecar and
  serves embedded settings/dashboard UIs.

The testing implications that shape everything below:

- **The proxy is a translation boundary.** Most defects are wrong
  *transformations* of a request/response payload, not crashes. Correctness is
  about the exact shape and field values sent upstream and returned
  downstream. This is why contract/translation tests dominate and why we care
  about mutation testing (a payload can be subtly wrong while every line is
  "covered").
- **Upstream behavior is partly undocumented.** Copilot's endpoint semantics
  (which models support `/responses`, how `thinking.display` surfaces reasoning,
  which sampling params are rejected) are established empirically and can drift.
  Tests pin *our* behavior; they cannot pin the live upstream. See §7.
- **Auth touches real user credentials on disk.** Tests must never read or
  write the developer's real `~/.local/share/maximal` state. This is enforced
  globally (see §4).

---

## 2. Test taxonomy

We do not maintain a formal test-pyramid ratio. In practice the suite
(111 test files under `tests/`, ~1,195 assertions passing at time of writing)
breaks down into these layers:

| Layer | What it covers | Example files |
|---|---|---|
| **Pure-logic / unit** | Deterministic transforms, parsers, matchers, config resolution | `find-endpoint-model.test.ts`, `copilot-error-parser.test.ts`, `messages-preprocess.test.ts`, `anthropic-id-rewrite.test.ts` |
| **Contract** | The shape of a wire payload or a public response matches a published schema — or a single source of truth still agrees with its mirrors | `auth-status-contract.test.ts`, `config-schema.test.ts`, diagnostics schema round-trip in `settings-api-diagnostics.test.ts`, `i18n-catalog-parity.test.ts` |
| **Route / handler (in-process)** | A Hono route, exercised via `server.request(...)` / `app.fetch(...)` — no network, no listening port | `*-route.test.ts`, `*-handler.test.ts`, `debug-route.test.ts` |
| **Behavioral / lifecycle** | Stateful subsystems (auth controller, recovery, rate limit) across event sequences | `auth-controller-lifecycle.test.ts`, `auth-recovery.test.ts`, `copilot-rate-limit.test.ts` |
| **Mutation (manual, targeted)** | Whether tests *would fail* if the logic were wrong — see §6 | run on demand via `bun run mutate` |

`tests/i18n-catalog-parity.test.ts` is a contract test of the second kind: it
guards catalog ↔ Rust-mirror ↔ JS-term drift, pinning `shell/src/i18n/en.json`
as the single source of truth for OS-conditional terminology (see
[`i18n.md`](i18n.md)). The Rust tray side hand-mirrors the `app-container`
noun via `cfg!(target_os)` instead of an ICU runtime, and this test fails if
that mirror or the catalog spelling drifts.

**Not present today** (gaps, see §8):
- No end-to-end test against a real (or recorded) Copilot backend.
- No browser/visual regression test for the shell UIs. There is a **UI
  harness** (`bun run ui:harness`) that renders the settings/dashboard UIs with
  fixtures for manual inspection and screenshotting, but it is a developer tool,
  not an automated assertion.
- No formal coverage-percentage tracking (see §6 for why, and the caveat).
- No load/performance/soak testing.

---

## 3. Tooling

| Concern | Tool | Notes |
|---|---|---|
| Test runner | **`bun test`** | Native Bun runner. Fast; no Jest/Vitest layer. |
| Type checking | **`tsc`** (`bun run typecheck`) | `strict` TypeScript. Treated as a first-class gate, not advisory. |
| Lint (fast) | **oxlint** (`bun run lint:fast`) | Rust-based, runs first as a cheap filter. |
| Lint (authoritative) | **ESLint** (`bun run lint:all`) | Full-tree, **uncached**. This is what CI runs and is the source of truth. Local `bun run lint` is cached and can mask errors — see §5. |
| Mutation testing | **StrykerJS** (`bun run mutate`) | Manual, narrow-scope. `testRunner: "command"`. See §6. |
| Dead-code / unused deps | **knip** (`bun run knip`) | Part of `check:deep`. |
| Secret scanning | **trufflehog** + `scripts/secret-scan.sh` | Runs pre-commit (lint-staged) and in CI. |
| Design-token lint | `scripts/check-design-tokens.ts` | Guards the design system; UI work only. |

**Runtime pin:** Bun is pinned via `.bun-version` (currently `1.3.11`) and the
CI pin in `.github/workflows/ci.yml` / `.github/actions/setup-bun`. These
**move together** — a mismatch is a policy violation (see `CLAUDE.md` and
`docs/bun-version-policy.md`). Rationale: the test runner *is* the runtime, so a
Bun version delta can change test outcomes.

---

## 4. Test isolation & safety

Two global safeguards are registered via `bunfig.toml`'s `[test] preload`
(`tests/test-setup.ts`), applied before any module loads:

1. **Credential isolation.** `COPILOT_API_HOME` is redirected to a throwaway
   temp directory so `paths.ts` resolves `APP_DIR`, `ACCOUNTS_PATH`,
   `GITHUB_TOKEN_PATH`, and logs into temp. Without this, any test that reaches
   the real registry/token helpers would read and **write the developer's real
   sign-in state** — which has corrupted real credentials during test runs in
   the past. A test may set its own `COPILOT_API_HOME` and it wins.
2. **Generated-stub guarantee.** The gitignored `src/generated/ui-embed.ts`
   stub is force-created (empty) before any module imports it, so a fresh
   `git worktree` (which never ran `bun install`) doesn't fail server-boot
   tests with an opaque missing-module error. The stub is forced *empty* so a
   stray local build that populated the real embed can't make UI-route tests
   serve the embedded UI instead of their fixture dir.

Additionally the preload resets `consola.level` to Info (3) before every test,
because some tests raise verbosity and don't restore it, leaking flooding debug
output into later tests.

**Shared fixtures/helpers** live in `tests/helpers/` (`fake-executor.ts`,
`auth-flow-utils.ts`, `auth-status.ts`). Preference order for test doubles:
**injectable function options > `mock.module`** — for a hazard reason spelled
out in §5.

---

## 5. Known hazards (hard-won, must-read for contributors)

These are documented in `docs/architecture.md` → *Testing gotchas* and expanded
here because they are the failure modes most likely to bite a reviewer or a new
contributor.

### 5.1 `mock.module` persists forward across files in a run — now lint-enforced
Bun does **not** reset module mocks between test files, and CI orders files
differently than local. An unrestored mock leaks its stub into a *sibling* file
that then reads stale state — passing locally but failing in CI (or vice versa).
This bit the project **four times** (culminating in a long #229 debugging loop).
**Mitigations, in order of strength:**
- **Lint rule (enforced).** `mockModuleLeakGuard` (`eslint.config.js`, scoped to
  `tests/**`) errors on the fire-and-forget forms — `void mock.module(...)` and
  a bare `mock.module(...)` expression statement.
- **Awaited is *not* automatically safe.** `await mock.module(...)` passes the
  rule, but an awaited `afterAll` *restore* does **not** reliably land before the
  next file's static imports on CI — so a mock of a *shared* module still leaks.
  The rule catches the common footgun, not this one.
- **Durable fix: don't mock a shared module across files.** Prefer the **real**
  module — the preload redirects `COPILOT_API_HOME` to a temp dir and
  `getClaudeCodeSettingsPath()` honors `CLAUDE_CONFIG_DIR`, so config/settings
  round-trips are already isolated — or **injectable function options**. Only
  stub a module with no env/injection seam, keep the wrapper behaviorally
  identical (`...actual` / forward `...rest`), and prove with a sequential-import
  repro that it can't break a later file.

### 5.2 Green tests can still test nothing
A passing assertion does not prove the branch it claims to cover was exercised.
Mutation testing has caught classification tests whose fixture hit a *different*
code path that happened to return the same value. **Mitigation:** for
security-critical or branchy logic, run Stryker and confirm the targeted
mutants actually die. See §6.

### 5.3 Local cached lint ≠ CI lint
`bun run lint` is cached; `bun run lint:all` is the full uncached run CI
executes. A change can pass local cached lint and fail CI. **Always run
`lint:all` before pushing.** This has produced red CI on otherwise-good PRs.

### 5.4 Fresh worktrees need setup
A `git worktree` created for isolated work has no `node_modules` and no
generated stub. `bun install` (matches lockfile) and `bun run ensure:ui-embed`
may be required before typecheck/tests import cleanly. The preload handles the
stub for the test path specifically; typecheck does not get that for free.

---

## 6. Mutation testing (the differentiator, and the policy under active revision)

### How it's configured
StrykerJS, invoked manually via `bun run mutate`. The config
(`stryker.conf.json`) is **deliberately narrow**: `testRunner: "command"`
pointed at a single test file, `mutate` scoped to a single module. A run takes
~30s–2min. It is **not** wired into `check:fast` or `check:deep` — it is a
manual, targeted instrument, not a CI gate.

Usage pattern: point `mutate` at one pure-logic module, point the command
runner at that module's test file, run, then read the surviving mutants.

### Why we use it
Line/branch coverage answers "did this line execute?" Mutation testing answers
the question that actually matters for a translation proxy: **"if this line
were wrong, would a test fail?"** A concrete example from this codebase: an
extended-thinking display gate (`if (!hasThinking)`) shipped inverted. The
function had tests and green coverage — but no test fed an input that flipped
the gate, so the bug was invisible. Post-hoc Stryker flagged the exact mutant
(`if (!hasThinking) → if (true)` *survived*). That surviving mutant is the
bug's fingerprint; running mutation testing on that module beforehand would
have caught it.

### The disposition rule for surviving mutants

> A surviving mutant is proof that **no test can distinguish the real code from
> a changed version of it.** There are exactly three honest dispositions, each
> with a required action. "Documented-equivalent" as a catch-all is **not**
> acceptable.

1. **Killable** — the behavior is observable, we just don't assert it. →
   **Write the test that kills it.** Attach it; show Survived→Killed.
2. **Dead / unreachable** — no reachable input makes this code observable. →
   **Delete the code, or encode the impossibility in the type system** so the
   branch ceases to exist. A path that can't be observed is dead code or
   redundant defense, not a test exemption.
3. **Deliberately-retained equivalent** — a provable semantic equivalence we
   consciously keep (e.g. a defensive `?.` at a trust boundary we want despite
   the contract forbidding `undefined`). → Requires a **written proof over the
   reachable input domain** plus a rationale for keeping the code. "Looks
   equivalent" / "probably fine" is rejected.

The anti-pattern we are eliminating: accepting a live mutant because "we can't
write a test to observe it." If a test can't observe it, that is a finding
*about the code* (bucket 2), not a license to move on.

**Status of this policy:** codified (issue #216). The three scope items are
complete — this rule is written into the testing docs (and linked from
`docs/architecture.md` → *Testing gotchas*), the previously-dismissed
"equivalent" survivors were re-adjudicated (the request-preprocess audit found
several were in fact **killable**, including one reachable via a
`selectedModel?: Model` parameter the public contract genuinely allows to be
`undefined`), and the hot-path sweep list is named below.

**Deliberate non-goal:** we do **not** gate CI on a mutation-score threshold.
It is slow, flaky under concurrency, and a global number invites gaming. The bar
is the *per-survivor disposition rule above*, applied during review of
test/logic PRs — not a percentage.

### Modules that warrant periodic manual sweeps
The highest-value targets are the branchy, pure-logic transforms on the request
path: request preprocessing (`src/routes/messages/preprocess.ts`), the
translation layers (`*-translation.ts`), model dispatch/selection
(`src/lib/models.ts`, `find-endpoint-model`), the completion handler's
warmup-downgrade gate (`src/routes/messages/handler.ts` `handleCompletion` — it
mutates `payload.model` in place and can silently override an explicit model,
the same "green coverage, no assertion distinguishes the inverted branch" shape
this section targets), and domain-policy matching (`web-tools/state.ts`).

---

## 7. What tests can and cannot prove here

Because the proxy sits in front of a partly-undocumented upstream, it is
important to state the boundary of our guarantees honestly:

- **Tests pin our transformation.** We can and do assert that, given input X,
  the payload we send upstream (or return downstream) is exactly Y.
- **Tests cannot pin live upstream behavior.** Claims like "`thinking.display:
  "summarized"` is what surfaces reasoning text on Copilot-served Claude" or
  "only GPT models support `/responses`" are **empirically established**, not
  contract-guaranteed, and can drift when GitHub changes the backend. Where a
  fix depends on such behavior, the test verifies that we *send the right
  thing*; the end-to-end outcome rests on captured evidence (wire logs) and
  project-recorded knowledge, and is flagged as a residual risk in the relevant
  PR.
- **Implication for reviewers:** the most valuable defensive addition here is
  not more unit tests but a **recorded-fixture / contract-canary** mechanism
  against the real upstream, so drift is detected rather than silently
  degrading. This is a gap (see §8).

---

## 8. Known gaps & candidate improvements (for the review to prioritize)

We would specifically like external judgment on these:

1. **No upstream contract canary.** Undocumented Copilot semantics can drift
   with no signal until a user reports breakage. A periodic recorded/live
   contract check would convert silent drift into a failing check. *(Highest
   strategic value, in our view.)*
2. **Mutation testing is manual and ad-hoc.** No schedule, no defined module
   coverage list, results not archived. Policy in §6 is new. Risk: it only runs
   when someone remembers.
3. **No coverage measurement at all.** We intentionally avoid a coverage *gate*
   (§6), but we currently have no coverage *visibility* either — we cannot point
   at which modules are under-exercised without running Stryker on each. A
   reporting-only coverage signal (not a gate) may be worth adding.
4. **Shell UI has no automated assertions.** The `ui:harness` renders UIs for
   human review; there is no visual-regression or DOM-contract test. UI
   regressions rely on manual smoke + screenshots.
5. **Cross-file test-size cap friction.** Large single-domain test files
   approach the repo's `max-lines: 800` ESLint cap; independent PRs appending to
   the same file can collide and/or bust the cap on merge. Suggests a
   convention for splitting test files by concern.
6. **`mock.module` global-state hazard (§5.1)** — now partly enforced by a lint
   rule (`mockModuleLeakGuard`) that bans the fire-and-forget forms. **Residual
   gap:** the rule can't catch an *awaited-but-cross-file-leaky* mock of a shared
   module (an awaited restore doesn't reliably land on CI), so the convention
   "prefer real/injectable deps for shared modules" still rests on review.
7. **No load/performance/soak coverage** for the proxy under sustained
   concurrent request load or long-running sidecar sessions.

---

## 9. CI gates & the local equivalents

CI (`.github/workflows/ci.yml`) runs on every push/PR and is the merge gate.
Steps, in order:

1. Verify Node `node:sqlite` support (the app uses it).
2. Pinned Bun setup (`.github/actions/setup-bun`).
3. `bun install`.
4. **`bun run lint:all`** (full-tree, uncached ESLint).
5. **`bun run typecheck`** (`tsc`).
6. **`bun test`** (full suite).
7. **`bun run build`**.

Security workflows (CodeQL, trufflehog) and, on release, the gated
build/sign/publish pipeline (macOS dmg, Windows MSI verify, checksums, smoke)
run alongside. Release itself is Conventional-Commit-driven via release-please;
`test:`/`chore:`/`docs:` commits are release-silent (see `docs/architecture.md`
→ *Release & PR conventions* and `docs/release-runbook.md`).

**Local pre-merge equivalents:**

- `bun run check:fast` = `ensure:ui-embed → lint:fast → typecheck → lint:all →
  check:tokens`.
- `bun run check:deep` = `check:fast → bun test → knip`.
- **Pre-commit hook** (simple-git-hooks → lint-staged): `bun run lint --fix` +
  `scripts/secret-scan.sh` on staged files. Note this uses the *cached* lint;
  §5.3 still applies — run `lint:all` yourself before pushing.

The single most common CI-only failure is a lint error masked by the local
cache (§5.3). Running `check:fast` (which calls `lint:all`) before pushing
eliminates it.

---

## 10. Conventions summary (quick reference for reviewers)

- Test files: `tests/<subject>.test.ts`, colocated by subject, not by layer.
- Prefer **in-process** route testing (`server.request`) over spawning a
  listener.
- Prefer **injectable dependencies** over `mock.module` (§5.1).
- Never touch real user credentials; rely on the preload isolation (§4).
- For branchy/security-critical logic, **run Stryker and adjudicate every
  survivor** per the three-bucket rule (§6).
- Run **`lint:all`** (not cached `lint`) before pushing (§5.3).
- Keep Bun pins in lockstep (`.bun-version` ↔ CI).
