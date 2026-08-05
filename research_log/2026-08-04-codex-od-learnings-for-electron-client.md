# Codex + open-design learnings for the Electron-client-in-maximal + maximal-core roadmap

Spike output: mined `~/Claude/codex` (openai/codex study) and `~/Claude/od`
(open-design / Electron desktop app study) for learnings applicable to bringing an
Electron client into the maximal repo at `client/` that composes a generic
`stuffbucket/electron` shell + a spawned `maximal-core` sidecar.

Method: 11 reader agents over the two corpora → synthesis → adversarial critique
(76 grounded findings; every recommendation carries a source citation). The
critique's corrections are **folded into the recommendations below**; the raw
critique is preserved in the appendix for traceability. `od` = open-design specs,
`cx` = codex study.

---

## Executive summary

- **The sidecar boundary IS the architecture.** Running `maximal start` as a spawned
  HTTP sidecar on an ephemeral port — never in-process — is what simultaneously
  delivers crash isolation, independent release cadence, and non-disruption of the
  user's existing 4141 proxy. od and cx independently land on this as the single
  load-bearing decision (`06-embedding-runtime.md §8.2`, `10-sidecar-ipc-protocol.md §5.5`,
  `sdk-embedding-config.md §3`).
- **Isolation must be injected and fail-loud, not inferred.** Ephemeral `PORT=0` + an
  explicitly-passed, must-already-exist `COPILOT_API_HOME` + a parent-tracked pid check
  are the mechanical guarantees the client never adopts, collides with, or clobbers the
  4141 instance (`10-sidecar-ipc-protocol.md §5.3`, `04-host-footprint.md Tier 1`,
  `03-configuration.md §2`).
- **Two frozen contracts keep the three repos decoupled:** (a) electron-shell's
  `runMain(runtime, options)` seam, and (b) a *pure, validator-only* control-protocol
  package owned by maximal-core (auth DTOs, error envelope, event union) the renderer
  imports as its only knowledge of core (`02-electron-desktop-shell.md §5.1`,
  `13-daemon-http-api.md §5.1`, `00-overview.md #9`).
- **Independent cadence has to be machine-enforced, not hoped for:** SHA-pinned
  cross-repo deps + CI boundary guards (electron-shell imports nothing maximal-specific;
  client reaches core only via the sidecar/contract) convert "stay decoupled" into a red
  build (`03-quality-governance.md §5 Family B`, `playbooks/03…md`).
- **The device-flow auth loop is the highest-risk seam.** Three *distinct, complementary*
  patterns de-risk it — a retryable-pending poll-result code (od, `13-daemon-http-api.md §5.5`),
  a start/poll ownership split with host-owns-UX / core-owns-token (cx, `06-embedding-runtime.md §3.6`),
  and a deterministic device-flow fixture service (od, `06-testing-strategy.md §5.5`).
  *(Correction from critique: no single corpus describes all three — they compose.)*
- **A large slice of prior codex-maximal advice is now stale** (cargo Dependabot, Tauri
  DMG/Ed25519 signing, proxy-internal guards, old i18n catalogs) — the *patterns* survive
  but retargeted to the Electron client + npm CLI, never ported verbatim.

## Prioritized recommendations (impact vs effort)

| # | Recommendation | I/E | Corroboration | Sources |
|---|---|---|---|---|
| 1 | Spawn maximal-core as a sidecar on ephemeral `PORT=0` + explicit isolated `COPILOT_API_HOME`; parent-tracked pid handshake; fail loud on missing home; never bind 4141 | High / Low-Med | **od+cx** | `10-sidecar-ipc-protocol.md §5.3,§5.5`; `06-embedding-runtime.md §8.2`; `03-configuration.md §2`; `04-host-footprint.md Tier 1`; `sdk-embedding-config.md §3,§8` |
| 2 | Two-entrypoint split: electron-shell exports `runMain(runtime, options)` (tsc lib); `client/` owns the thin bootstrapper holding every maximal literal | High / Med | **od+cx** | `02-electron-desktop-shell.md §5.1,§4`; `11-plugin-runtime.md §8`; `06-embedding-runtime.md §1` |
| 3 | Pure validator-only contracts package (auth DTOs, error envelope, run/SSE event union) owned by core; renderer imports only it; must type-check/build **without** triggering `bun build --compile` | High / Med | **od+cx** | `13-daemon-http-api.md §5.1`; `09-ui-architecture.md §4,§6`; `00-overview.md #9`; `sdk-embedding-config.md §2` |
| 4 | Poll-result envelope on a closed `code` union incl. auth states (`AUTH_PENDING` retryable / `AUTH_EXPIRED` / `AUTH_DENIED` / `AUTHORIZED` success); switch with `never`-check; host owns UX, core owns token store | High / Low | **od+cx** (split: od envelope, cx ownership) | `13-daemon-http-api.md §5.4,§5.5`; `06-embedding-runtime.md §3.6`; `04-host-footprint.md rule #7` |
| 5 | One CI-side `guard` binary (no git hooks) with AST boundary checks: shell-agnostic (in shell's own CI), core-public-api-only, no-committed-sidecar, core-pin-drift | High / Med | **od+cx** | `03-quality-governance.md §3,§5 Family B`; `04-agentic-harness-enablement.md §5.2`; `playbooks/03…md`; `00-overview.md #1` |
| 6 | Exact dependency pinning across all manifests; pin electron-shell + maximal-core to a full 40-char git SHA (branch/tag/`*` fail) | Med / Low | partial | `03-quality-governance.md §5 A2`; `01-build-system.md §5.1`; `playbooks/06…md §2` |
| 7 | SHA-pin every GH action + `verify_action_pins.sh` gate; OIDC trusted-publish + `--provenance` for the CLI; drop `NPM_TOKEN` | High / Low | cx | `playbooks/06…md §1,§3`; `targets/maximal-recommendations.md P0/P1`; `00-overview.md #10` |
| 8 | Sidecar **source-freshness** guard: hash core source inputs, stamp beside the compiled binary, fail with "recompile" before the Electron main spawns a stale sidecar | Med / Low | od | `01-build-system.md §5.5` (finding [17]) |
| 9 | L2 node-mode smoke against the real built sidecar + deterministic GitHub device-flow fixture service (scriptable pending/denied/expired) | High / Med | od | `06-testing-strategy.md §5.2,§5.5`; `04-agentic-harness-enablement.md §5.3` |
| 10 | Fresh typed i18n dictionary (`Record<TranslationKey,string>`, missing key = tsc error) + thin structural check; do NOT resurrect Tauri catalogs | Med / Low | od | `03-quality-governance.md §5 D2`; `08-design-system.md §9` |
| 11 | Layered config: deep-merge (siblings preserved), single core validator, process-only overrides (port, home) separate from persisted schema, capped risky knobs, migration-error strings | Med / Med | cx | `03-configuration.md §3.1,§4.2,§10`; `sdk-embedding-config.md §5` |
| 12 | Packaging CLI in `client/` (not shell) generating electron-builder config in code; ASAR disabled / sidecar `asarUnpack`ed; per-triple native runners; compile sidecar once, every channel downloads that byte | Med / Med-High | cx | `05-packaging-distribution.md §3,§5.1`; `01-build-system.md §5.4`; `01-distribution.md §8` |
| 13 | **`min_supported_version` force-upgrade lever**: server-controlled file the proxy enforces (fail-open, 2s timeout, logic compiled into signed client) — the security retire-a-vulnerable-build channel for a proxy with no Dependabot | Med / **High** | cx | `02-updater.md §3` |
| 14 | electron-updater single signed channel, notify-only 3-option modal (never auto-apply mid-session); passive JSON cache for CLI banner; install-method self-identification | Med / Med | cx | `02-updater.md §2,§4,§8`; `01-distribution.md §6` |
| 15 | Loopback + `Host`-header fail-closed origin guard until the ephemeral port resolves (unconditional). *HMAC/`REQUIRE_DESKTOP_AUTH` capability gate is **conditional** — adopt only if core gains filesystem-import-class / privileged routes* | Med (origin) / Low; gate deferred | od-only | `13-daemon-http-api.md §5.5`; `10-sidecar-ipc-protocol.md §6.2`; `02-electron-desktop-shell.md §5.3d` |
| 16 | Neutral design-system chrome (System 1 only): one `tokens.css`, dark declared twice, pre-hydration + runtime theming sync with identical ratios (guard with equality test) | Med / Med | od | `08-design-system.md §5.1–5.5` |
| 17 | AGENTS.md/CLAUDE.md contract per package (each rule cites its guard) + task-runner as the repo API + CI tiering (fast PR / post-merge OS matrix) | Med / Low-Med | cx | `playbooks/01…md`; `playbooks/02…md`; `playbooks/03…md`; `targets/maximal-recommendations.md P1,P2` |
| 18 | Per-entry total-result folding for the **client's** Models catalog (one bad model → skipped card + diagnostics warning, never blank the grid) — zod `.passthrough()` unknown fields to a doctor view | Low-Med / Low | od | `11-plugin-runtime.md §5.2,§6.6` |

> **⚠ Core-prerequisite recommendations.** Several of the above cannot land client-side —
> they require an upstream change in `@stuffbucket/maximal-core` first (which is on its own
> cadence). See the consolidated list in §5. Notably: strict fail-loud `COPILOT_API_HOME`
> (rec 1), a structured stdout ready-line for port discovery (rec 1), a tree-shakably-pure
> contracts sub-entry (rec 3), `GITHUB_API_BASE` override for the auth fixture (rec 9),
> keyring token store (rec 4), and `min_supported_version` enforcement (rec 13).

---

## 1. Shell + sidecar wiring & IPC / control API

**Two-entrypoint seam (rec 2).** electron-shell ships `runMain(runtime, options)` as a tsc
library; the `options` object (`discoverDaemonUrl()`, `preloadPath`, `beforeShutdown()`) is
the *versioned* maximal↔shell contract. `client/` owns only a thin bootstrapper that spawns
maximal-core, discovers its ephemeral URL, and injects it. Every maximal literal (port env
names, `COPILOT_API_HOME`, `/control/*` paths) lives in the bootstrapper, never in the shell
(`02-electron-desktop-shell.md §5.1`). *Topology decision first:* if the shell serves the
renderer bundle over `app://` and core is the only sidecar, a web-URL callback collapses to a
local path — decide before wiring callbacks (`§4` risk).

**Port discovery — use a structured ready-line, not the od socket-STATUS (corrected).** od's
`STATUS`/pid-match handshake (`10-sidecar-ipc-protocol.md §5.5`) assumes a namespace-derived
Unix-socket / named-pipe control plane. **Our sidecar speaks HTTP and likely has no such
plane.** The realistic mechanism is: spawn with `PORT=0`; core emits a **typed stdout
ready-line** `{port, pid}` (finding [71]); the orchestrator parses it, polls `/health` with
geometric backoff (~150ms→1.5s), races the child `exit`, and matches the reported pid against
the spawned `child.pid` so a stale socket or the 4141 proxy can't be adopted. **This is a
required core change** if `maximal start` currently only logs human-readable text — add a
structured ready line (or fall back to probing a written port-file). Also take [71]'s bounded
stderr ring buffer for crash diagnostics.

**Namespace + explicit data dir.** `COPILOT_API_HOME` must be delivered at spawn and core must
*fail loud*, never fall back to a shared default. **Audit core for port-independent global
state** (token cache, fixed lockfile) before trusting isolation (`§5.3`, `§9`). Add a
concurrency test: two homes up at once, distinct endpoints; stopping one leaves the other
running; neither touches 4141.

**One runtime, many thin front-ends (rec 3, strong od+cx agreement).** maximal-core is the only
place proxy logic runs; the Electron client and CLI are both thin clients of one control/proxy
contract over the port — never importing core internals. This is exactly what lets electron-shell
stay generic: it knows only "spawn a subprocess, talk to a port" (`06-embedding-runtime.md §1`,
`00-overview.md #1`). Keep the interaction-model reasoning from cx: device-flow is
bidirectional/stateful → model the link as one long-lived session with a readiness handshake,
and buffer control events (auth-completed) that can land before the UI subscribes
(`sdk-embedding-config.md §1`). Do **not** import codex's duplex stdio MessageRouter — our
channel is HTTP.

**Env hygiene at spawn.** Hand core a *curated allowlisted* env (isolated home, ephemeral port,
provider tokens only if needed, a rebuilt PATH) — not the inherited desktop env — to scope
secrets and stop a stripped launchd PATH from breaking core's outbound tooling. Teardown in a
`finally` on quit/close/error (`10-sidecar-ipc-protocol.md §5.7`, `sdk-embedding-config.md §8`).
Note `ELECTRON_RUN_AS_NODE` does **not** apply to our `bun --compile` binary; the transferable
lesson is the allowlist + PATH rebuild.

## 2. Daemon HTTP contract + renderer / UI

**Pure contracts package (rec 3).** All request/response DTOs, the SSE event union, and the
error envelope live in one package whose only runtime dep is the repo's zod validator — no
framework, no fs/process. Both core (producer) and renderer (consumer) import the single barrel,
so shapes can't structurally drift (`13-daemon-http-api.md §5.1`). **Critical structural
requirement:** the contracts sub-entry must be tree-shakably pure so `client/` type-checks/builds
*without* triggering `bun build --compile` or dragging in the engine — otherwise "client builds
without the engine" is lost (`§5.1` risk).

**Poll-result envelope + auth (rec 4, corrected).** `{ error: { code, message, details?,
retryable?, requestId? } }`; clients discriminate on `code`, never HTTP status. `GET /control/auth`
returns `retryable:true` for `AUTH_PENDING`; the renderer drives the poll with `switch(code)`
guarded by a `never` default so adding a code is a compile error (`13-daemon-http-api.md §5.4`).
**`AUTHORIZED` is a terminal *success* state, not an error** — model the union as poll-result
codes (success + error members), not an "error-only" union. Ownership split (cx): host owns
device-code UX, core owns the token write — store the GitHub token in the OS keyring or a `0600`
file inside the isolated home, treating the home as a bearer-token surface
(`06-embedding-runtime.md §3.6`, `04-host-footprint.md rule #7`).

**Client-only SPA + single feature-detected bridge (rec 3).** Route all sidecar data over
`fetch()` bound to the contracts types; forbid `ipcRenderer` in feature code. Native powers
(external-link open, auto-update, file picker) go through one injected namespaced global exposing
`{ version, client:{ osLocale } }` returning `{ok}` envelopes; the renderer degrades to a plain
website when absent. The dependency-free `sandbox:true` preload duplicates channel literals rather
than importing them, keeping the shell's preload free of maximal code (`09-ui-architecture.md §3`,
`02-electron-desktop-shell.md §5.3b`). `client.osLocale` seeds the fresh i18n when hosted.

**Run/SSE lifecycle — scoped by plane (updated 2026-08-05; see `docs/decisions/0023-control-plane-jsonrpc-over-http-sse.md`).** The `Last-Event-ID` replay-then-subscribe / append-only-log design (`POST→202+id`, dual-sourced cursor `Number(Last-Event-ID || ?after || 0)`) applies **only to `/v1` proxy streams** — OpenAI/Anthropic passthrough, whose SSE semantics are the upstream API's, not ours. The **control-plane feed is stateless SSE-over-JSON-RPC, MCP-aligned**: no `Mcp-Session-Id`, no `Last-Event-ID` resumability (MCP removed both in spec 2026-07-28). On (re)connect the client re-reads current state via `server/discover`/`status` (snapshot-on-connect), then subscribes; a dropped feed is retried as a **fresh POST, never resumed**. Proactive server→client signals are JSON-RPC **notifications** (no `id`, stream stays open); a **response** (`id` + `result`/`error`) is terminal for its request, so an in-flight-request failure closes that stream and is retried as a new POST. There are **no server-initiated JSON-RPC requests** (MCP replaced them with client-driven `input_required`). SSE hardening applies on both planes: `text/event-stream`, `no-cache,no-transform`, `X-Accel-Buffering:no`, single-socket-write per frame, keepalive on an unref'd timer; the renderer uses a pure `parseSseFrame` that skips bad-JSON frames, and *always emits a terminal frame* so an Electron reload never hangs on "done or dropped?". Skip all of this for small synchronous control calls (`13-daemon-http-api.md §5.2`, `09-ui-architecture.md §5.3`). This supersedes the WebSocket feed transport of ADR-0019, whose driver (Tauri browser-tab presence, ADR-0018) the Electron client removes.

**Ephemeral-origin injection.** Because the port is chosen at startup, hand `DAEMON_ORIGIN` to the
renderer at runtime (via the bridge in prod, dev-server rewrite of `/api,/frames` in dev) so it
hits one origin with no CORS. "Static export + runtime-injected origin" is the only output mode an
Electron client needs (`09-ui-architecture.md §5.1`).

**Resilient rendering (rec 18).** Parse provider/model config with zod `.passthrough()`, routing
unknown-but-plausible fields to a diagnostics "doctor" view as warnings, not errors. Fold the
Models catalog per-entry with total `{ok}` results so one malformed model degrades to a skipped
card. *This targets the **new `client/` models view**, not the retired `shell/` Tauri code — the
pattern is the same but the destination is the client (corrected from critique M1).* The prior
"stop the Manage section blanking" fix (#401) and the card-grid redesign (#400) are the
motivating precedent (`11-plugin-runtime.md §5.2,§6.6`).

## 3. Packaging, distribution & auto-update

**Build once, matrixed (rec 12).** One release workflow compiles maximal-core per triple (darwin
arm64/x64, linux x64/arm64, win x64) + a `SHA256SUMS`; both the CLI's npm/brew packaging and the
Electron app-builder step *download that same artifact* so the binary a CLI user runs and the
binary the client spawns are bit-identical (`01-distribution.md §8`). Verify the bun-compiled
binary's glibc floor on old Linux.

**Packaging CLI + native payload (rec 12).** A client-local `tools/pack` CLI (`mac|win|linux` +
build/install/start/stop/logs/cleanup) generates the electron-builder config *in code* from a
maximal identity record with a dead `publish` URL — so the shell ships no static build block and
stays agnostic. **ASAR disabled / sidecar `asarUnpack`ed**: a `bun --compile` binary is per-OS
native code that cannot be spawned from inside an asar archive; resolve it by absolute unpacked
path. CI needs native runners per triple — you cannot cross-emit a compiled binary
(`05-packaging-distribution.md §5.1`, `01-build-system.md §5.4`).

**Auto-update (rec 14).** Electron, so translate Tauri advice: `electron-updater` against **one**
signed manifest (`latest.yml`), OS code-sign + notarize so the built-in signature check is
meaningful, notify-only 3-option modal (Update now / Later / Skip; Esc = Later), never install
while a proxy session is in-flight. The Electron client is its own single channel — do **not**
port the CLI's multi-registry reconciliation into it (`02-updater.md §8`).

**`min_supported_version` force-upgrade (rec 13 — raised, per critique P2).** Split out from the
update-UX niceties and rank higher: a small live-fetched file the proxy enforces as a
force-upgrade lever, with matching logic compiled into the signed client (2s timeout, **fail-open**).
For a proxy that impersonates upstream clients, the ability to force-retire a vulnerable build is a
higher-tier security control than the modal/cache it was bundled with (`02-updater.md §3`).

**Install-method self-identification (rec 14).** Core detects `InstallMethod { NpmGlobal, Brew,
Standalone, EmbeddedInElectron, Other }` via env markers first (CLI npm shim + a
`MAXIMAL_MANAGED_BY_ELECTRON=1` marker the client sets at spawn), path heuristics second.
`EmbeddedInElectron` → "the app updates itself, suppress CLI upgrade nags"; `Other` → emit nothing
(`02-updater.md §4`).

**Digest-pinned sidecar (rec 6/13 bridge).** Commit a DotSlash-style manifest pinning the
maximal-core binary by version + size + sha256; verify before first spawn (tamper-evidence for a
security-sensitive proxy), refuse on mismatch. Upgrading = regenerate + commit — the deliberate,
independent-cadence bump we want (`01-distribution.md §6`). *Note (critique P3): this is a
hardening layer — do not gate standing up the basic supervisor on manifest tooling; the
source-freshness guard (rec 8) is the more useful early dev-loop check.*

## 4. Config + host footprint + embedding model

**Single relocatable home, fail-loud (rec 1/11).** The client creates/verifies an isolated home
under userData and passes it explicitly; when the home var is set, core must require-exists +
canonicalize + fail (only lazily-create in the unset default case). This asymmetry is the
mechanical guarantee the two proxies stay isolated (`03-configuration.md §2`,
`04-host-footprint.md Tier 1`).

**Layered config with provenance (rec 11).** Fold sources by fixed precedence with one recursive
deep-merge (tables merge key-by-key; scalars/arrays replace), keeping a per-key origin map. Place
the client's mandatory spawn overrides (isolated home, ephemeral port) at a precedence a user file
cannot override; reserve a higher managed tier for future GitHub-org policy. Defer codex's full
`Constrained<T>`/MDM engine until a real org policy exists (`03-configuration.md §3.1,§8`).

**Persisted vs process-only split (rec 11).** Model the ephemeral port + isolated home as a typed
*runtime-overrides* struct applied after file config — never written back to any persisted schema.
The shell just fills the struct, staying agnostic (`03-configuration.md §4.2,§10.4`).

**Round-trip through core's validator + migration errors (rec 11).** Validate the merged config
with core's own schema (one validator, not a second in the Electron layer); cap risky knobs
(retries/timeouts/port range); when core renames/drops a control field across independent versions,
return a specific "moved to X" error keyed off the handshake version so a newer client against an
older sidecar fails legibly (`sdk-embedding-config.md §5`).

**Sidecar-over-HTTP is the cadence-decoupling embedding (rec 1/2).** In-process would compile core
into the shell and force version lockstep, violating agnosticism. Keep the crash-isolation /
lifecycle discipline (health check, restart, graceful shutdown) the sidecar path requires; skip the
stdio JSON-RPC router (`06-embedding-runtime.md §8.2`).

## 5. Independent-cadence build / dependency boundaries

**Per-package self-contained build, no aggregate root.** `client/` declares its own
build/typecheck/test; add **no** maximal-root "build everything" step coupling client + core +
site. The Electron main is a runtime that spawns a native sidecar and touches module resolution → a
no-bundle `tsc`/bun target so spawn/resource paths stay faithful; reusable libs/CLIs are the
bundle-for-deps case (`01-build-system.md §3,§5.3,§5.4`).

**Engine and shell in separate packages joined by a narrow versioned contract (rec 2/3).**
electron-shell must not import maximal-specific types; if it renders provider/model data it receives
opaque data through the contract. Version the contract independently so either side ships without
lockstepping. Define the seam in electron-shell's *generic* vocabulary, or you leak maximal concepts
into the "agnostic" shell (`11-plugin-runtime.md §8`, `00-overview.md #9`).

**Protocol generated outward, capability-gated at handshake (rec 3).** Core owns the
control-protocol types and emits TS declarations (+ optionally JSON Schema) pinned to the compiled
sidecar version; the client consumes generated bindings, and a startup handshake reports protocol
version + capabilities so the client feature-detects instead of assuming. Mark generated files "do
not edit"; a CI test asserts committed == regenerated. Minimum viable: one shared typed package +
handshake — defer multi-language codegen until a second consumer exists (`sdk-embedding-config.md §2`).

**Exact/SHA pinning (rec 6).** Every dep is `workspace:*`, exact semver, or a full 40-char git SHA
(branch/tag/`*`/`#main` fail). SHA-pinning the two cross-repo edges is *what makes* independent
cadence real — an update lands only on a deliberate reviewed bump (`03-quality-governance.md §5 A2`).
Dependabot can't cleanly bump arbitrary floating git refs — this reinforces moving core/shell toward
**tagged releases** so bumps become reviewable PRs (`playbooks/06…md §2` risk).

**Toolchain pins agree everywhere (rec 6).** Generalize the existing `.bun-version` + CI-pin house
rule: any file encoding the runtime version for client, shell, or core must agree, asserted by a
policy test; bump in lockstep (`01-build-system.md §5.1,§8`).

### ⚠ Consolidated "requires a maximal-core change first" list (critique G2)

Because core is a separate package on independent cadence, these are **not** client-side
adoptions — schedule them as upstream core work:

1. **Fail-loud, require-exists `COPILOT_API_HOME`** when the var is set (rec 1) — and an audit for
   port-independent global state (`§5.3`, `§9`).
2. **Structured stdout ready-line** `{port,pid}` for port discovery (rec 1) — core likely only logs
   human text today (`[71]`).
3. **Tree-shakably-pure contracts sub-entry** importable without `bun build --compile` (rec 3).
4. **`GITHUB_API_BASE` override** so the device-flow fixture can redirect auth (rec 9) — if
   hardcoded, this is a core change before the offline auth test can exist.
5. **Protocol codegen from core** + version/capabilities handshake (rec 3).
6. **Keyring / `0600` token store** owned by core (rec 4).
7. **`min_supported_version` enforcement** in the proxy path (rec 13).

## 6. Testing & deterministic mocks

**L2 node-mode smoke (rec 9).** The primary tier: a framework-neutral harness spawns the *built*
sidecar on port 0 with a fresh temp `COPILOT_API_HOME`, waits on `/health`, exercises `/control/*`
and `/v1` over HTTP — no browser, no Electron. Build the core before running L2 or binary staleness
masks code changes — see rec 8 (`06-testing-strategy.md §5.2`).

**Deterministic GitHub device-flow fixture (rec 9).** Stand up a local server speaking device-flow
(`device_code`/`user_code` → `authorization_pending`→`slow_down`→`access_token`) with scriptable
timing (immediate / N-pending / denied / expired); thread a `GITHUB_API_BASE` override into the
spawn. **Requires** core to accept a base-URL override (see §5 list). Keep one rare human-driven
real-auth smoke outside the fixture path (`06-testing-strategy.md §5.5`).

**Worker-scoped real-backend fixture (rec 9).** Each Playwright worker boots its own sidecar on port
0 with its own `COPILOT_API_HOME` under a `pid+workerIndex` namespace — the isolation that proves
two runs (and the real 4141) never share state. Assert the client *always* launches with an explicit
home + port 0, never a default (`06-testing-strategy.md §5.3`).

**Electron test pyramid (rec 9).** PRs: main-process units with `vi.mock('electron', …)` on cheap
Linux (window creation, spawn glue, auth IPC). Release: per-OS packaged smoke self-gated on
`process.platform === … && PKG_E2E_<OS>==='1'`, driving `eval fetch(sidecarUrl+'/control/auth')`
inside the installed app (`06-testing-strategy.md §5.4,§5.8`).

**PATH-overlay fake `maximal` (optional).** A shim named `maximal` on `PATH` lets UI tests drive
spawn/lifecycle deterministically without a real core. If the client only ever spawns the one
binary, a single scripted fake + the fixture service may suffice without a full recording corpus
(`06-testing-strategy.md §5.5` risk).

## 7. CI guards, governance & supply-chain

**One CI-side guard binary, no hooks (rec 5).** `scripts/guard.ts` = an ordered `{name,run}[]`
registry, sequential, prints `file:line -> fix`, sets `exitCode=1`. CI-only (no husky/lefthook,
`core.hooksPath` unset) so no `--no-verify` bypass and neither repo forces hook config on the
other's clones (`03-quality-governance.md §3,§5`).

**AST boundary import isolation (rec 5).** Build an app registry from `package.json` names, parse
with the TS compiler API, collect *real* import edges (incl. `require.resolve`/`createRequire`
laundering), flag foreign-boundary targets. In `client/`: forbid deep imports into electron-shell
src, allow only its published entry. **In electron-shell's own CI**: deny-by-name any
`maximal`/`@stuffbucket/maximal-core` import — a regex would false-positive on quoted snippets and
miss `createRequire`. **Because electron-shell is a separate repo, the agnostic check must live in
*its* CI** — an in-maximal guard can't police the dependency's own source
(`03-quality-governance.md §5 Family B`; `playbooks/03…md` risk).

**Product-neutrality string scan (rec 5 companion).** In electron-shell CI, scan src+docs+strings
for env-injected `FORBIDDEN_TERMS='maximal,maximal-core,copilot'` (word-boundary) so the shell repo
forbids maximal names *without committing them* (`03-quality-governance.md §5 D1`).

**Supply-chain (rec 7).** SHA-pin every action + `verify_action_pins.sh` gate (P0 the moment we hold
Electron signing/notarization secrets — the exact secret-bearing runner). OIDC trusted-publish +
`--provenance` for `@stuffbucket/maximal`, delete `NPM_TOKEN` (the `npm-trusted-publishing` skill
encodes the workflow). Dependabot: `npm` (client+root, grouped minor+patch) + `github-actions`;
**explicitly ignore the electron-shell + maximal-core git-deps** so cadence stays manual
(`playbooks/06…md §1,§3`, `targets/maximal-recommendations.md P0/P1`). *(Citation corrected: this is
playbooks/06 + targets, not `02-updater.md`.)*

**CI tiering.** Fast PR tier: lint/tsc/unit + cheap guards on ubuntu; post-merge `ci-full.yml`
matrix `[macos, windows]` builds the sidecar + packages the client + smoke-asserts ephemeral-port +
home isolation + does NOT bind 4141 (`playbooks/03…md`; `targets/maximal-recommendations.md P1`).

**Agent-in-CI (defer).** A propose-only, fork-guarded, SHA-pinned labeler could check these
invariants — but it's a maintainer-time win, not on the critical path; build it *after* the
deterministic guards (`playbooks/04…md`).

## 8. i18n & design system

**Fresh typed i18n (rec 10).** The old Tauri catalogs are parked on `platform/tauri` — do not
resurrect. Model `type Locale = 'en'|…`, `type TranslationKey = keyof typeof en`, each locale
`Record<TranslationKey,string>` so an omitted key is a `tsc` error; wire `bun run typecheck` as the
gate + a thin structural check for locale registration. Start en-only; the type shape guarantees
parity the moment a 2nd locale is added. Seed the locale from the bridge's `client.osLocale` when
hosted, else browser locale. Compiler parity ≠ wording quality — still route through the i18n
reviewer in `CONTRIBUTORS.md` (`03-quality-governance.md §5 D2`, `02-electron-desktop-shell.md §5.3b`).

**Neutral chrome, System 1 only (rec 16).** One `tokens.css` (neutral ramp/fills/borders, single
accent + derived states, closed radius scale, one ease-out, OS-native font stacks); dark declared
twice (explicit `[data-theme=dark]` + `@media prefers-color-scheme`). The pre-hydration inline
script + runtime `applyAppearance()` must encode *identical* ratios/color-space/default — the single
most fragile seam; guard it with a computed-vars equality test. **Drop System 2** (brand/artifact
tokens) and macOS-native-window chrome — the client is a proxy control panel, not an artifact
generator (`08-design-system.md §5.1–5.5,§8`).

## 9. AGENTS.md contract / task-runner API for the multi-package repo

**AGENTS.md per package, each rule citing its guard (rec 17).** Root `/AGENTS.md` for cross-cutting
rules; `client/AGENTS.md` for client-specific ones (keep `CLAUDE.md` a thin pointer). Encode
anti-goals a linter can't fully express, each with an "enforced by X" that actually runs:
"electron-shell stays maximal-agnostic — enforced by `verify_shell_agnostic`"; "client spawns
`maximal start` on an ephemeral port with isolated `COPILOT_API_HOME`; never bind 4141 — that is the
user's own proxy"; "fresh i18n only". An unenforced clause is a lie the next agent trusts. **The
literal `shell/`+`site/` targets in the old codex recommendation are stale** (`shell/` was the Tauri
app) — retarget to `client/` + the core boundary (`playbooks/01…md`; `targets/maximal-recommendations.md P2`).

**Task runner as the repo API (rec 17).** Keep bun scripts authoritative; add package-scoped verbs
(`client:dev`, `client:build`, `client:check`, `core:build-sidecar`) and a top-level pre-PR gate.
The sidecar `bun build --compile` is exactly the tribal-knowledge command that must become a named
recipe CI calls verbatim, so local == CI. Avoid a monolithic check coupling client + core builds —
that works against independent cadence; keep per-surface scripts (`playbooks/02…md`).

---

## Stale vs still-valid: prior codex-maximal recommendations

**Now STALE (excavation / Tauri retirement):**

- **cargo Dependabot ecosystem** — the Rust/Tauri crate is retired to `platform/tauri`; keep only
  `npm` + `github-actions` (`targets/maximal.md`).
- **macOS DMG signing via private `macos-builder` + self-hosted runner; winreg / `src/lib/platform/`
  OS-matrix justification** — Tauri-installer/proxy-specific; the proxy moved to maximal-core.
  Electron needs its own notarization path; scope the OS matrix to what the *client* packages.
- **Tauri Ed25519 / `latest.json` updater + the four tauri-updater skills** — replaced by
  electron-updater's own signing/verification.
- **`tokenAttachmentGuard` and other proxy-invariant guards (ADR-0001 single-credential-attachment)**
  — enforce logic that now lives in maximal-core; don't port them here.
- **Old i18n catalogs** — went with the Tauri shell to `platform/tauri`; the client needs fresh i18n.
- **Multi-registry CLI update reconciliation applied to the *client*** — the Electron client is
  single-channel; this stays valid only for the dual-registry CLI.

**Still VALID (reborn, often stronger):**

- **Dependabot / OIDC trusted-publish + provenance / SHA-pin actions** — *more* central now: maximal
  is the CLI-distribution repo and is becoming an app publisher holding signing secrets.
- **Executable-guards-over-prose + AGENTS.md contract + task-runner-as-API + CI tiering** — the
  multi-package tree (client + shell dep + core dep) multiplies the boundaries these enforce.
- **Plugin trust tiers (source × capability)** — speculative; build only if the client later ingests
  user/remote providers or MCP servers.

## First 3 things to do when the Electron client lands

1. **Stand up the sidecar supervisor as the foundation.** In the client bootstrapper: allocate an
   ephemeral free port, create/verify an isolated `COPILOT_API_HOME` under userData, spawn the
   maximal-core binary with a curated allowlisted env, discover the port via the structured
   ready-line + `/health`, match the reported pid against `child.pid`, and register teardown in
   `finally` on quit/close/error. Add the **source-freshness guard** (rec 8) so a stale sidecar
   fails with "recompile," and ship the concurrency test proving it runs alongside a default-namespace
   proxy and never touches 4141. *(Digest-verification is a later hardening layer, not a gate on this
   step.)*

2. **Carve the pure contracts package and turn the boundaries into red builds.** Create the
   validator-only contracts sub-entry in core (auth DTOs, error envelope, event union; importable
   without `bun build --compile`), have the renderer import only it, and land `scripts/guard.ts` with
   the AST checks — `core-public-api-only` in the client, `no-maximal-in-shell` in electron-shell's
   *own* CI, `no-committed-sidecar`, `core-pin-drift` — wired into the fast PR tier and cited from
   `client/AGENTS.md`.

3. **Wire the device-flow auth state machine against a deterministic fixture.** Implement the closed
   `code`-union poll-result envelope (`AUTH_PENDING`/`EXPIRED`/`DENIED`/`AUTHORIZED`), a `never`-checked
   poll switch (host owns UX, core owns keyring token store), and prove it end-to-end with a local
   GitHub device-flow fixture service (needs the `GITHUB_API_BASE` core override) driven from an L2
   node-mode smoke against the built sidecar — the highest-risk seam, made testable offline before any
   UI or packaging exists.

---

## Appendix — adversarial critique (raw, for traceability)

The synthesis above was adversarially reviewed; the corrections are already folded in. Summary of
what the review caught:

- **O1 / P1** — the HMAC `REQUIRE_DESKTOP_AUTH` gate was presented as required; both source findings
  make it *conditional* on core exposing filesystem-class privileged routes. → demoted to rec 15,
  marked conditional; the unconditional loopback+Host origin guard kept.
- **O2** — "od+cx agree" was inflated on the auth items; each corpus describes a *different subset*
  (od: retryable envelope + fixture; cx: ownership split). → corroboration labels corrected.
- **O3** — the `STATUS`/pid-match handshake is od's socket-IPC mechanism; our HTTP sidecar needs a
  typed stdout ready-line (`[71]`) instead, flagged as a required core change. → §1 rewritten.
- **O4** — rec 7 miscited `02-updater.md`; real support is `playbooks/06 §3` + targets. → corrected.
- **G1** — sidecar **source-freshness** guard (`[17]`) was dropped; it's distinct from digest-pinning
  (dev-loop staleness vs released-artifact tamper-evidence). → added as rec 8.
- **G2** — no consolidated "requires a core change first" list. → added in §5.
- **G3 / G4** — provider-adapter architecture (`[38]`) and portable tested-script skill bundles
  (`[67]`) dropped; noted as lower-priority core-scoped follow-ups.
- **M1** — internal contradiction: rec 16 mapped the Models-catalog folding onto the *retired*
  `shell/` while §9 calls `shell/` stale. → retargeted to the new `client/` models view (rec 18).
- **M2** — `AUTHORIZED` was placed inside an "error" union; it's a success poll-result. → union
  reframed as poll-result codes.
- **P2** — `min_supported_version` force-upgrade lever (M/**high**) was buried in a Med/Med grab-bag.
  → split out and raised to rec 13.
- **P3** — First-3 item 1 over-front-loaded digest verification. → replaced with the source-freshness
  guard as the early dev-loop check; digest-pin noted as later hardening.
- The review found the agnosticism-boundary handling, the shell-agnostic-guard-in-shell's-own-CI
  placement, and the Tauri/i18n/proxy-guard "stale" classification **sound**.

---

*Provenance: Workflow `mine-codex-od-learnings` (run `wf_288155d1-30c`), 11 reader agents over
`~/Claude/codex` + `~/Claude/od`, 76 grounded findings → synthesis → adversarial critique.
Sources are the study corpora, themselves grounded in the real `openai/codex` and open-design
clones. Generated 2026-08-04.*
