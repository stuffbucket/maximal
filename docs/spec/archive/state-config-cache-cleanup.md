> **Status:** archived 2026-05 — work has shipped or been superseded.

# State / config / cache cleanup — PRD

Status: Draft, 2026-05-01.
Owner: bstucker.
Scope: Scoping pass over the proxy's runtime state, configuration
loading, and caching surfaces. Driven by the observability gap
exposed by the `OLLAMA_API_KEY`-not-in-env incident
(2026-05-01 14:19 sessions): the proxy was misconfigured for hours
and the only visible signal was `web_search` returning `unavailable`
in the daily log.

## TL;DR

- Most of the diagnostic pain comes from **configuration being
  invisible at runtime** — the proxy doesn't surface what it thinks
  its config is, so a missing env var becomes a multi-step
  investigation.
- We tackle six small commits that improve observability and validation
  without touching the architecture: `debug` subcommand expansion,
  zod-validated config, debug-route for live state, cache wrapper +
  metrics, secrets file, env/precedence README section.
- We defer the larger refactor (kill the global `state` singleton in
  favor of a `RuntimeContext` passed via Hono middleware) — it's the
  architecturally correct answer but yields less pain reduction per LOC
  than the smaller fixes.

## Problem

Three categories of friction surfaced during the web-tools rollout:

1. **State is hard to observe.** The `state` singleton in
   `src/lib/state.ts` holds tokens, models, rate-limit data, and the
   `verbose` flag. There's no way to inspect it without a debugger or
   `ps eww`. The `OLLAMA_API_KEY` incident took two grep cycles plus
   `ps eww` to diagnose; it should have been one command.
2. **Config sources are scattered.** CLI flags, env vars, the
   on-disk config, and hardcoded constants combine in undocumented
   precedence. A misconfigured value fails lazily mid-request rather
   than loudly at boot.
3. **Caches are unbounded and unobservable.** `state.models`,
   `OllamaWebExecutor.prefetch`, and several smaller caches share no
   wrapper. None expose hit/miss counts. None can be cleared without
   a process restart.

The cumulative effect: failures are debuggable only by reading source.

## Goals (what success looks like)

| Goal | Acceptance signal |
|---|---|
| Misconfigurations fail at boot, not at request time | `bun start` with bad config exits non-zero with the offending key named |
| The proxy can answer "what do you think your config is?" in one command | `copilot-api debug` prints effective config + cache sizes + executor selection (secrets masked) |
| Live state is inspectable on a running proxy | `GET /_debug/state` returns the same shape, gated on `--verbose` or a flag |
| Cache pressure is visible | Each cache reports `{ name, size, max, hits, misses, evictions }` in `/_debug/state` |
| Secrets aren't in shell history or env-var leaks | Provider keys load from `~/.local/share/copilot-api/secrets/<name>` (chmod 600), env still wins for ad-hoc dev |
| Precedence is documented | One short table in README for CLI > env > file > defaults |

## Non-goals

- **Performance optimization.** This pass is about observability and
  correctness, not throughput.
- **Multi-tenant support.** Singleton state is fine for a
  single-user proxy; the refactor is deferred.
- **New features.** No new providers, no new tools, no new CLI
  subcommands beyond expanding `debug`.
- **Hot config reload.** Restart-to-apply is an explicit choice for
  this milestone; live reload would block on the deferred singleton
  refactor.

## Scope: in this milestone

Six additive commits + a pre-cleanup deletion pass. Each is
independently mergeable, ordered by debugging dividend per LOC.

### M0. Pre-cleanup deletion pass (status: complete)

Three deletion candidates landed before M1 to keep subsequent diffs
clean. Result:

| Sub-milestone | Outcome |
|---|---|
| **M0a.** Remove `contrib/ollama-anthropic-spike/` after lifting the index-bookkeeping discipline into a permanent comment in `web-tools-stream.ts` | Done in `e4e109a`. −4,342 / +11. |
| **M0b.** Drop unused `defaultExecutor` export | No-op — constant was already removed in an earlier `simplify pass` commit. Audit confirmed via `grep -rn defaultExecutor src/ tests/` returning empty. |
| **M0c.** Consolidate `DEFAULT_TIMEOUT_MS` / `DEFAULT_MAX_CHARS` into `web-tools-vocab.ts` | Skipped — audit found these constants live only in their single user (`web-tools-executor.ts`), so this would be stylistic re-shuffling rather than deduplication. Net-neutral on LOC. Filed as deferred. |

Net M0 reduction: ~4,330 LOC.

### M1. `feat(debug): print effective config + cache sizes + executor selection` (status: complete — `b4297c0`)

**Change:** expand `copilot-api debug` to emit:

```
config:
  port: 4141
  account_type: enterprise
  use_messages_api: true
  small_model: claude-haiku-4.5
  log_retention_days: 7
  ollama_api_key: <set>          # never the value
  anthropic_api_key: <unset>
  github_token: <set, expires …>

executor:
  web_tools: OllamaWebExecutor (base=https://ollama.com/api)

caches:
  models                size=27   max=∞     hits=0   misses=1
  copilot_token         size=1    max=1     hits=12  misses=1
  prefetch (per-req)    avg_size=2.3 over last 100 requests

paths:
  app_dir: $HOME/.local/share/copilot-api
  log_dir: $HOME/.local/share/copilot-api/logs
  secrets_dir: $HOME/.local/share/copilot-api/secrets
```

**Acceptance:** running `copilot-api debug` matches the shape above
with real numbers; secrets masked as `<set>` / `<unset>`. Test:
unit test asserting the output contains `<set>` not the actual key
when env is populated.

**Estimate:** ~80 LOC across `src/debug.ts`, one helper.

### M2. `feat(config): zod-validate AppConfig at boot` (status: complete — `a9475eb`)

**Change:** add `zod` (or `valibot` — pick whichever has lighter
runtime). Define `AppConfigSchema` mirroring the existing
`AppConfig` interface. Validate in `loadConfig()` and exit non-zero
on failure with the offending key path.

**Acceptance:**
- A typo in `~/.local/share/copilot-api/config.json` exits with
  `[config] config.providers.<name>.authType: expected one of
  "authorization" | "x-api-key", got "..."`.
- Unknown keys produce a warning (not a fatal — backwards-compat
  hedge), logged at startup.
- Existing valid configs continue to work without modification.

**Estimate:** ~120 LOC including schema. ~40 LOC test coverage.

### M3. `feat(observability): /_debug/state route (verbose-gated)` (status: complete — `7b0a65b`)

**Change:** add a `GET /_debug/state` Hono route returning the same
JSON shape as M1's `debug` subcommand. Gated on `state.verbose ===
true` OR a new `--debug-routes` CLI flag (off by default).

**Acceptance:**
- Route returns 404 when not gated.
- When gated, returns the live config + caches + executor.
- Secrets masked identically to M1.
- Documented in README under "Operations."

**Estimate:** ~50 LOC + integration test.

### M4. `refactor(cache): introduce Cache<K,V> wrapper + metrics` (status: complete — `f8e45bd`)

**Change:** new `src/lib/cache.ts` ~50 LOC:

```ts
export interface CacheMetrics {
  name: string
  size: number
  max: number
  hits: number
  misses: number
  evictions: number
}

export class Cache<K, V> {
  constructor(opts: { name: string; max: number })
  get(key: K): V | undefined
  set(key: K, value: V): void
  clear(): void
  metrics(): CacheMetrics
}
```

LRU eviction via the standard insertion-order trick (`Map` is
insertion-ordered in spec). Wrap `state.models` and
`OllamaWebExecutor.prefetch` initially. Register every instance in
a module-level `cacheRegistry` so M1/M3 can iterate them.

**Acceptance:**
- All wrapped caches appear in `debug` output with hit/miss
  counters.
- Existing tests pass without changes (wrapper is API-compat with
  `Map.get/set`).
- New unit tests for LRU eviction and metrics increment.

**Estimate:** ~100 LOC + tests.

### M5. `feat(secrets): read provider keys from ~/.local/share/copilot-api/secrets/` (status: complete — `84d45e8`)

**Change:** loader checks for `~/.local/share/copilot-api/secrets/<provider>`
files at startup. Reads any present, validates `chmod 600`, refuses
to load and warns if mode is broader. Env var still wins
(`OLLAMA_API_KEY` env > `~/.local/share/copilot-api/secrets/ollama`
file > absent).

**Acceptance:**
- A file mode of 0644 produces a startup warning and the file is
  ignored.
- `OLLAMA_API_KEY` env var continues to work as before (regression
  guard).
- `copilot-api debug` shows the source: `<set, env>` /
  `<set, secrets/ollama>` / `<unset>`.

**Estimate:** ~80 LOC + tests. Touches `src/lib/config.ts` and
`src/start.ts`.

### M6. `docs: precedence + env var reference in README` (status: complete — `3e06609`)

**Change:** one section in the project README:

```
## Configuration

Precedence (highest first):
  1. CLI flags
  2. Environment variables
  3. ~/.local/share/copilot-api/secrets/<provider>
  4. ~/.local/share/copilot-api/config.json
  5. Built-in defaults

| Knob | CLI | Env | Config | Default |
|---|---|---|---|---|
| port | --port | COPILOT_API_PORT | n/a | 4141 |
| ollama key | n/a | OLLAMA_API_KEY | secrets/ollama | unset |
| log retention | n/a | n/a | logRetentionDays | 7 |
| ...
```

**Acceptance:** review by a fresh reader who can answer "where do I
set the Ollama key" in <30 seconds.

**Estimate:** documentation-only. ~30 LOC.

## Scope: deferred

Filed as tracked tasks; revisit when one of the listed triggers
fires.

| Item | Defer reason | Trigger to revisit |
|---|---|---|
| `RuntimeContext` replacing global `state` singleton | Architecture-correct but blocks none of the user-visible pain. ~400 LOC across the request path; high risk for low immediate dividend | Multi-tenant requirement, parallel test flakiness becoming routine, or hot-reload becomes a goal |
| Trace-ID propagation to Copilot upstream (`x-request-id`) | Useful for support cases that involve correlating with Copilot side, but no current incident demands it | A user reports an upstream-attributed bug we can't correlate |
| Models-list refresh strategy (timer or stale-while-revalidate) | Restart picks up changes; daily restart cadence is acceptable for a dev proxy | A user reports a missing newly-released model that requires same-day visibility |
| Cache-clear admin command (`copilot-api cache clear`) | Process restart suffices today | Someone needs to clear without restarting (e.g., long-lived production deployment) |
| ~~Log retention configurability~~ | ✅ landed — `logRetentionDays` config knob (default 7, `0` deletes on every cleanup tick); zod-validated, surfaced in `copilot-api debug` | n/a |
| Per-instance prefetch cache → shared/configurable | Per-request scope is the right primitive; promotion to shared is a foot-gun | Cross-request cache hit-rate becomes a measurable win, which it isn't with our request shapes today |
| `--print-config` flag (separate from `debug` subcommand) | M1 covers it via `debug`; one entry point is enough | If `debug` grows enough to be unwieldy and config-only printing becomes a separate ask |
| Stylistic consolidation of executor-local constants in vocab (was M0c) | Audit showed they're not actually duplicated; moving them is style not dedup | If a third executor adds its own copy of timeout/max-chars defaults |
| HMAC-signed `encrypted_content` (~30 LOC) | Tampering would be undetectable, but extension-injection is not a current attack surface; client tolerates whatever we emit | A user-installed extension is observed mutating round-tripped blobs |
| E2E test harness against live Copilot (~200 LOC, network + auth gated) | Unit tests cover wire-shape synthesis; E2E catches integration drift but is expensive to run and maintain | A regression slips through unit tests because of upstream wire-shape change |
| Silence `baseline-browser-mapping` lint warning | The package's age-of-data heuristic fires even at the literal latest version (2.10.25, published 2026-05-01). Bumping doesn't help; suppression would require patching the upstream eslint plugin | A clean-lint requirement (e.g., CI step that fails on any warning) is added |

## Follow-ups surfaced during implementation

Items not in the original M0–M6 scope but identified while landing
them. Each is a small win on its own; ranked by likelihood of earning
back the time. Listed here rather than discarded so the next "what
should I work on" question is answerable from `git log -- docs/spec/`.

### Code

| Item | Status |
|---|---|
| DRY `describeExecutor` against `selectExecutor` | ✅ landed `f21204b` |
| Streaming agent test coverage | ✅ landed `bd662d0` |
| Reuse `trimTo` for HTML input cap | ✅ landed `37a0513` (surfaced by simplify pass) |
| Six findings from simplify review (SECRET_DEFS, summarizeConfig, FakeExecutor, ExecutorChoice, etc.) | ✅ landed `52837ff` |
| Wrap `state.models` / `state.copilotToken` with metrics — needed a `SingletonCache` shape | ✅ landed `47bffbe` (primitive) + `3c1f749` (setters via `state.ts`) |

### Documentation

| Item | Status |
|---|---|
| `docs/spec/web-tools.md` D6 status | ✅ confirmed not actually broken on review |
| `CLAUDE.md` debug surfaces + worktree convention | ✅ landed `53259d1` |
| Worktree convention for parallel agents | ✅ landed `53259d1` |
| PRD completion stamps | ✅ this commit |

### Hygiene

| Item | Status |
|---|---|
| `baseline-browser-mapping` lint warning | ❌ won't fix at this layer — moved to deferred above; latest version still triggers the heuristic |
| `.github/workflows/` audit | ✅ confirmed `ci.yml` runs lint + typecheck + tests + build on push and PR; nothing to change |

## Risks

- **zod adds runtime weight.** Mitigation: `zod` is ~50KB minified
  and already a transitive dep of multiple projects we vendor; swap to
  `valibot` (~5KB) if bundle size becomes a concern.
- **Existing config files might fail validation.** Mitigation: unknown
  keys produce warnings, not fatals (M2). Validate against a real
  `config.json` from this user before merging.
- **Secrets file loading order subtly changes behavior.** Mitigation:
  M5 explicitly preserves env-wins-over-file, with regression test.
- **`/_debug/state` route accidentally exposed in production.**
  Mitigation: gated on `--verbose` or `--debug-routes`, never
  reachable in default config. Document the gate prominently.

## Success criteria

End-to-end test for the original incident: a proxy started without
`OLLAMA_API_KEY` should be diagnosed in **one** command, not seven.

```sh
$ copilot-api debug | grep -i ollama
ollama_api_key: <unset>          # was: required to debug via ps eww
executor.web_tools: InProcessFetchExecutor (search disabled; set OLLAMA_API_KEY)
```

If a future user hits the same situation and resolves it in one
command without reading source, the milestone delivered its value.

## Out of scope (this PRD)

- Web-tools work — covered by `docs/spec/web-tools.md`
- Tool-bridge work — covered by `docs/spec/tool-bridge.md`
- MDM / egress — covered by `docs/admin/claude-desktop-mdm.md`
- Provider expansion (new inference backends) — separate effort

## Sequencing notes

M1 unblocks the rest because every subsequent commit produces output
that should appear there. Suggested merge order: M1 → M2 → M4 → M3 →
M5 → M6. M3 depends on M4 (cache metrics surface), M5 is independent,
M6 wraps up.

If only one commit lands: do M1. The single largest reduction in
"why isn't this working" round-trips comes from one well-shaped
debug output.
