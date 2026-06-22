# Why Claude Desktop may not work out of the box with maximal (macOS)

Date: 2026-06-22
Scope: macOS only. Maps the failure surface between "user toggled Claude
Desktop ON in maximal (or ran `configure-claude-desktop`)" and "Claude
Desktop actually routes inference through the local gateway and works."

Method: three parallel code/doc audits over the `research/claude-desktop-failures`
worktree (origin/main), cross-checked against `fix/friendly-model-not-supported`.
Every item has a file:line anchor and a user-visible symptom.

## ✅ RESOLVED — root cause confirmed, fix built and validated (2026-06-22)

**Root cause (confirmed, not hypothesis).** maximal writes a single flat
file to `~/Library/Application Support/Claude/claude_desktop_config.json`
(the classic MCP-server path). Current Claude Desktop (v1.13576.0) runs its
third-party/Cowork mode out of a **separate `Claude-3p/` userData dir** —
the build unconditionally redirects userData via `app.setPath("userData",
…)` to the `-3p` suffix — and reads its inference config from a **two-file
config library** there: `Claude-3p/configLibrary/<id>.json` (gateway
profile, pointed to by `_meta.json` `appliedId`) + `Claude-3p/claude_desktop_config.json`
(top-level `deploymentMode` + prefs). maximal's write lands in a directory
the live app ignores → "toggle ON, nothing happens." See **§G/§H** for the
on-disk evidence, binary disassembly, and live validation.

**Fix (built + validated).** Write the config library into `Claude-3p/`
instead. Validated end-to-end on a real host — including a **clean-room
run** (both dirs moved aside, Developer Mode off, no prior identity): the
app booted straight into Gateway/3P, auto-provisioned a fresh local
identity, discovered 7 gateway models, **no Anthropic sign-in**. Toggle-off
cleanly reverts to standard mode. The MDM `.mobileconfig` path is the
robust alternative for managed fleets (read regardless of userData dir,
survives corporate MDM) — generated and `plutil`-valid, but its install was
not tested here (needs GUI/MDM on macOS 26). Telemetry hardened per
requirement: all three telemetry knobs off, `disableAutoUpdates:false`
(update checks preserved). Implementation: **`src/lib/claude-desktop-3p-config.ts`**
(this worktree). Generator/`.mobileconfig`/test harness in `/tmp/cd-fix/`.

**Still TODO:** wire the module into `src/routes/settings/apps.ts` (toggle)
+ `src/configure-claude-desktop.ts` (CLI), reflect the managed-vs-file
"off" asymmetry in the UI (§H4), and add tests.

> **Reading guide.** Sections below are in *investigation order*: **A–E**
> are the original failure-mode hypotheses (written before the root cause
> was found — still valid as secondary issues); **§G** is the on-disk
> ground truth; **§H** is the binary-confirmed mechanism, the fix, and the
> live/clean-room validation; **§F** is the Anthropic-docs cross-check.
> For the answer, read §G → §H first.

## TL;DR — the most probable "out of the box it just doesn't work"

Original ranked suspect list (before the root cause was confirmed). Item 0
turned out to be **the** cause; 1–5 remain valid as secondary/contributing
issues — see the RESOLVED box above and §G/§H.

0. **✅ CONFIRMED — wrong config path.** maximal writes `Claude/claude_desktop_config.json`;
   the live build reads `Claude-3p/configLibrary/`. The write is inert. See §G/§H.
1. **Claude Desktop was already running when the toggle wrote the file.**
   Nothing restarts it; it only reads `claude_desktop_config.json` at
   launch. Toggle shows ON, Claude Desktop keeps its old state. → needs
   `Cmd+Q` + relaunch, and nothing tells the user.
2. **MDM / managed-preferences tier silently shadows the file write.**
   maximal writes the *file* tier; precedence is server-managed > MDM >
   file. If `/Library/Managed Preferences/com.anthropic.claudefordesktop.plist`
   (or user-defaults) carries `deploymentMode` / `inferenceProvider` /
   `inferenceGatewayBaseUrl`, the file is ignored. maximal only clears
   **one** MDM key (`coworkEgressAllowedHosts`), and `defaults delete`
   cannot touch a managed profile anyway.
3. **The user never ran the second step.** `maximal setup` is
   client-neutral and does **not** wire Claude Desktop; pairing is an
   opt-in toggle/CLI step. A user who only ran setup has nothing wired.
4. **First-run sign-in gate.** If the persisted `deploymentMode` the app
   actually reads at launch isn't `"3p"`, Claude Desktop shows the
   Claude.ai sign-in screen even with the gateway fully wired.
5. **Proxy not running / not authenticated / wrong model.** Connection
   refused (proxy down or port busy), 401 (no GitHub token), or
   `model_not_supported` (Claude Desktop requests a model the Copilot
   account lacks) — each surfaces as an opaque error inside Claude Desktop.

---

## A. First-contact failures (most likely to be the report)

### A1. Restart requirement — config change not picked up live
- `src/routes/settings/apps.ts:239-258`, `src/lib/claude-desktop-config.ts:316-346`
- The toggle / `applyProxyConfig()` only **writes the file**. Nothing
  signals or restarts Claude Desktop. It reads the config at launch only
  (`docs/admin/claude-desktop-mdm.md:135` "Restart Claude Desktop after
  any change").
- Symptom: toggle reads ON, but a running Claude Desktop never connects
  to the gateway until the user quits and relaunches. No prompt says so.

### A2. setup vs configure split — nothing wired Claude Desktop
- `src/setup.ts:1-17,88-90`, `src/configure-claude-desktop.ts:1-26`
- `maximal setup` is deliberately client-neutral; it prints (CLI only) a
  hint to run `maximal configure-claude-desktop`. The GUI toggle lives in
  Settings → Apps. A user who ran setup but never toggled / never ran the
  command has **no config written at all**.
- Symptom: "I installed maximal and Claude Desktop still talks to
  claude.ai" — because the pairing step was never performed.

### A3. MDM / managed-preferences tier shadows the file (managed Macs)
- `docs/admin/claude-desktop-mdm.md:25-27` (precedence: server-managed >
  MDM/OS > file), `src/configure-claude-desktop.ts:121-166`
- maximal writes the file tier and clears only the **one** MDM key
  `coworkEgressAllowedHosts` via `defaults delete`. Any other key present
  at the MDM tier (`deploymentMode`, `inferenceProvider`,
  `inferenceGatewayBaseUrl`, `disableAutoUpdates`, …) is never inspected
  and silently wins over the file. `applyProxyConfig()` still reports
  "config updated."
- `defaults delete` operates on **user defaults** only; a key delivered
  via a configuration profile (`/Library/Managed Preferences/…plist`)
  cannot be removed this way, and `deleteMdmAllowedHosts()` just returns a
  generic warning with no fix path (`src/configure-claude-desktop.ts:158-166`).
- Symptom: on a Jamf/Kandji/Intune-managed Mac, routing partially or fully
  fails with no error; behaves differently from an unmanaged machine.

### A4. First-run sign-in gate / persisted deploymentMode
- `src/lib/claude-desktop-config.ts:101-109` writes `deploymentMode:"3p"`
  to the **file** to skip the sign-in gate. But the app reads its
  *persisted* mode at launch; if that persisted value (in defaults / app
  state, or an MDM `"1p"`) isn't `"3p"`, the gate still fires.
- `alreadyConfigured()` only inspects the file (`:232-244`), so it can
  report "already configured" while the effective persisted mode differs.
- Symptom: Claude Desktop shows the Claude.ai sign-in screen despite the
  gateway being fully wired in the file.

---

## B. Proxy/runtime not reachable or not ready

### B1. Proxy not running / port 4141 busy → connection refused
- `shell/src-tauri/src/lib.rs` (sidecar binds 127.0.0.1:4141),
  `src/lib/start/port.ts:29-61` (probe → exit if busy)
- If the sidecar isn't started, crashed, or another process holds 4141,
  Claude Desktop's requests to `http://127.0.0.1:4141` get connection
  refused. (See memory: `--replace` eviction / stale pidfile field report.)
- Symptom: "Failed to fetch" / timeout in Claude Desktop.

### B2. Bootstrap race — first request before models cached
- `src/lib/start/run-server.ts:170-207`; Tauri polls `/setup-status`
  every 300ms up to 30s (`shell/src-tauri/src/lib.rs`).
- Token exchange + Copilot model fetch takes seconds; a request arriving
  during bootstrap can hit an empty `state.models` and fail.
- Symptom: first message fails, retry later succeeds — looks flaky.

### B3. Not authenticated → 401
- `src/lib/request-auth.ts:263-274` (`requireGithubAuth` gates
  `/v1/messages`, `/v1/models`).
- If maximal booted without a GitHub/Copilot token, every completion 401s
  before reaching upstream. Claude Desktop has no way to surface the
  "Open Settings → Account" hint.
- Symptom: opaque "API Error" / unauthorized; nothing works.

### B4. API-key enforcement rejects the literal `"anything"`
- `src/lib/request-auth.ts:108-114,166-177`
- Config sends `Authorization: Bearer anything`. If `auth.enforce` is on
  and `"anything"` isn't in the allowlist, the proxy 401s.
- Symptom: 401 even though the proxy is up and GitHub-authenticated.

---

## C. Model routing — the "model not supported" class

### C1. Empty model list when the Copilot catalog fails to load
- `src/routes/models/route.ts:10-44` returns `data: []` when
  `state.models` is null (upstream fetch failed/timed out).
- Symptom: empty model picker in Claude Desktop; "model not found" on send.

### C2. `model_not_supported` — requested model absent on the account
- `src/lib/anthropic-id-rewrite.ts:84-103` (variant → base fallback);
  if even the base model isn't in the Copilot list, the upstream returns
  `400 model_not_supported`.
- On `main`, this is forwarded raw (`src/lib/error.ts`). The
  `fix/friendly-model-not-supported` branch reframes it with available
  models + a recovery step (`src/lib/upstream-error-advice.ts:126-155`),
  but degrades to "switch via /model" when the catalog is empty.
- Symptom: "The requested model is not supported" — opaque on main, and
  the user's Copilot plan simply may not include the model Claude Desktop
  defaults to.

### C3. Endpoint-capability fallback to Chat Completions
- `src/routes/messages/handler.ts:124-173` — if the model lacks
  `/v1/messages` support metadata it falls back to Chat Completions,
  which Copilot may reject for that model.
- Symptom: "bad request" / unsupported.

---

## D. Lifecycle & state divergence

### D1. Claude Desktop auto-update resets/migrates config
- `src/lib/claude-desktop-config.ts:116` sets `disableAutoUpdates:false`.
  An app update may migrate the config schema and drop unknown keys; no
  reconciliation in maximal.
- Symptom: worked, then stopped after a Claude Desktop update.

### D2. UI/file state divergence; persisted flag unused
- `src/routes/settings/apps.ts:97-110` derives `enabled` from
  `alreadyConfigured(readClaudeDesktopConfig())` — an all-or-nothing
  deep-equal over every key (`claude-desktop-config.ts:232-244`). A single
  externally-changed key flips the toggle to OFF even with 15/16 correct.
  The persisted `config.apps.claudeDesktop.enabled` (`apps.ts:159-171`) is
  written but never read.
- Symptom: toggle shows OFF despite a mostly-correct config; re-toggling
  churns the file.

### D3. Install order — config written before the app exists
- `src/configure-claude-desktop.ts:57-64` (`--force` path). Claude
  Desktop's own first-run/installer may overwrite or ignore the
  pre-written file; maximal never re-validates post-install.
- Symptom: config "present" but the app never adopted it.

### D4. Uninstall leaves config pointing at a dead proxy
- `src/uninstall.ts:358-384` — revert is opt-in (`--revert-claude`).
  Default uninstall leaves `inferenceGatewayBaseUrl:127.0.0.1:4141`
  pointing at a now-gone proxy.
- Symptom: after uninstalling maximal, Claude Desktop fails to connect.

---

## E. Environment edge cases

- **E1. App not at `/Applications/Claude.app`** — detection is hardcoded
  (`src/configure-claude-desktop.ts:38,112-119`); `~/Applications`,
  Homebrew Cask, or a renamed bundle aren't detected (only affects the
  install warning / `claudeDesktopInstalled()` readiness, not the write).
- **E2. Gatekeeper / quarantine** — `com.apple.quarantine` on a freshly
  downloaded Claude.app blocks first launch; config is written but the app
  never runs to read it. Not detected/handled.
- **E3. Workspace folder** — `ensureWorkspaceFolders()` silently swallows
  mkdir failures (`claude-desktop-config.ts:352-362`); a sandboxed/App
  Store Claude Desktop may also be unable to attach `~/Claude`.
- **E4. Version skew** — the 16-key allowlist is written unconditionally;
  older/newer Claude Desktop may ignore or rename keys with no migration
  (`claude-desktop-config.ts:23-41`).
- **E5. `defaults read/delete` fragility** — output parsing is
  string-based (`configure-claude-desktop.ts:141-156`) and the "absent"
  vs "deleted" success messages are indistinguishable (`:121-139`).
- **E6. App Support dir** — `mkdirSync` on a bad `$HOME` / network-home /
  read-only mount throws and surfaces only as a generic "Could not update"
  (`claude-desktop-config.ts:257-262`).

---

## G. EMPIRICAL GROUND TRUTH — working host, 2026-06-22 ✅

Verified on a **working, unmanaged** Mac (`/Applications/Claude.app`,
bundle `com.anthropic.claudefordesktop`, **v1.13576.0**). This settles F1.

**The same app keeps two userData directories and runs out of the 3P one:**
- `~/Library/Application Support/Claude/` — stale standard-mode dir (most
  files dated May 1). Its `claude_desktop_config.json` was last written
  **Jun 18** — that is maximal's write, and it is **inert**.
- `~/Library/Application Support/Claude-3p/` — the **active** dir for the
  Cowork/third-party build (Cookies, caches updated Jun 19). This is what
  the running app reads.

**In the working `Claude-3p` dir the config is SPLIT across two files:**
1. `Claude-3p/configLibrary/a7394ba4-…json` — the **applied inference
   profile** (pointed to by `_meta.json` `appliedId`), created **May 2 via
   the in-app Developer-Mode "Configure third-party inference" window**,
   untouched since. Contents (verbatim):
   ```json
   { "coworkEgressAllowedHosts": ["*"], "disableDeploymentModeChooser": true,
     "inferenceProvider": "gateway", "inferenceGatewayBaseUrl": "http://127.0.0.1:4141",
     "inferenceGatewayApiKey": "claude", "disableEssentialTelemetry": true,
     "disableNonessentialTelemetry": true, "allowedWorkspaceFolders": ["/Users/brian/Claude"] }
   ```
2. `Claude-3p/claude_desktop_config.json` — top-level, holds
   **`deploymentMode": "3p"`**, `coworkUserFilesPath`, and the `preferences`
   block (incl. `coworkWebSearchEnabled`).

**maximal writes** a single flat file to `Claude/claude_desktop_config.json`
with all 17 keys mashed together (`inferenceProvider`, gateway wiring,
`deploymentMode`, the `isDesktopExtension*` keys, etc.).

### What this proves
1. **F1 confirmed — wrong directory.** The 3P build reads `Claude-3p/`;
   maximal writes `Claude/`. maximal's write never reaches the running app.
   On this host the gateway only works because the profile was authored
   **by hand in the app's Developer-Mode UI**, not by maximal. A user who
   only flips maximal's toggle gets nothing wired into the live app.
2. **F1 refined — wrong shape, too.** Even pointed at `Claude-3p/`, the
   gateway keys must go in `configLibrary/<appliedId>.json` (and be
   referenced by `_meta.json`), not a flat top-level file. `deploymentMode`
   + `preferences` belong in the top-level `claude_desktop_config.json`.
   maximal's single-flat-file model doesn't match either tier.
3. **`deploymentMode:"3p"` IS real and load-bearing** (present in the
   working top-level file). So F2 is a *documentation* gap, not a maximal
   bug — maximal is right to write it, just to the wrong place.
4. **`inferenceModels` is NOT required** — absent from the working profile,
   yet inference works. **Strike F3** (earlier "likely missing" concern was
   wrong); the gateway's own `/v1/models` listing is sufficient.
5. **`inferenceGatewayApiKey` value is cosmetic** — working host uses
   `"claude"`, maximal uses `"anything"`; both fine. No `inferenceGatewayAuthScheme`
   in the working profile (defaults to `bearer`) — maximal's explicit
   `"bearer"` is harmless.

### The corrected root-cause statement
maximal targets the **legacy single-file location** (`Claude/claude_desktop_config.json`,
the classic MCP-server config). Current Claude Desktop runs its
third-party/Cowork mode out of a **separate `Claude-3p/` userData dir**
using a **two-file config-library** format. The maximal write lands in a
directory the live 3P app ignores → "toggle ON, nothing happens." This is
almost certainly the dominant cause of the field reports, independent of
the (still-valid) managed-tier (A3) and restart (A1) issues.

### No Anthropic login required — confirmed (2026-06-22)
On the working host, Claude Desktop's Settings → Profile shows Full name
and "What should Claude call you?" both set to **"Cowork 3P"** (avatar
"C3") — a **synthetic local identity**, not a Claude.ai account. The
`ownerAccountId` in `cowork-enabled-cli-ops.json` is this app-generated
local id. So third-party mode runs with **no Anthropic sign-in**: the app
self-provisions a local Cowork-3P identity once `inferenceProvider` is set.
Implication: the only job is to get the app into 3P mode at first launch
(write the right keys to the right place) — no account/SSO work needed for
the basic case. The defaults/managed domain on this host is empty and no
config profile is installed, so the working config is purely the file-tier
`configLibrary` written via Developer Mode — and that path never triggered
an Anthropic login.

### How the fix works (open question resolved in §H1/§H5)
The app picks the `Claude-3p` userData dir **unconditionally** for this
build (binary: `app.setPath("userData", …)` with the `-3p` suffix — §H1),
so the fix simply writes there: (a) the gateway keys into
`configLibrary/<id>.json` + register in `_meta.json`, and (b)
`deploymentMode`/prefs into the top-level file. The MDM `.mobileconfig`
path (read regardless of userData dir) is the robust alternative for
managed fleets. Both validated/built — see §H3/§H5.

## H. Mechanism confirmed from the app binary + install doc — THE FIX (2026-06-22)

Read directly from `Claude.app/Contents/Resources/app.asar` (v1.13576.0)
and `claude.com/docs/cowork/3p/installation`. This closes both open
questions and decides the fix.

### H1. userData dir is hard-suffixed `-3p` by the build (caveat #2 resolved)
- Binary: `A4A="-3p"`, and `const A=app.getPath("userData");return A.endsWith(A4A)?A:`${A}…`` — the build appends `-3p` to the Electron userData base. So **this build's data dir is `~/Library/Application Support/Claude-3p`**, deterministically. It is **not** a runtime toggle maximal can influence; it's the build identity. maximal's write to `Claude/` is dead for this build, full stop.

### H2. The app reads `/Library/Managed Preferences/.../com.anthropic.claudefordesktop.plist` and forces 3P (caveat #1 resolved)
- Binary: domain constants `OCo = _U = "com.anthropic.claudefordesktop"` (and Windows `SOFTWARE\Policies\…`); it builds `/Library/Managed Preferences/${user}/${domain}.plist` paths and, when a managed source is found, sets `{ isManaged: true, managedConfig: … }` and the config library becomes `appliedId:"", entries:[], isManaged:true` (the in-app window goes **read-only**).
- Doc (verbatim): *"When the app launches and finds a managed configuration, it enters 3P mode automatically with no user sign-in or setup required."* / *"Deploying the configuration before the app means end users open Claude for the first time and land directly in Cowork, with no opportunity to sign in to claude.ai by mistake."* / *"Do not sign in or create an Anthropic account."* / *"When any managed source is present, it takes effect and the in-app configuration window becomes read-only."*
- The internal keys are all real: binary shows `deploymentMode` (with a `--boot-1p-once` CLI flag), `disableDeploymentModeChooser` (category "sandbox"), `forceLoginOrgUUID` (category "connection"), and `inferenceProvider` switch arms for `gateway`/`anthropic`/`mantle`/etc. So maximal's `deploymentMode` reverse-engineering was correct — it's just a doc omission.
- **Plain user-level `defaults write` is NOT the documented forcing mechanism.** The `isManaged`/read-only/no-sign-in path keys off the **Managed Preferences** plist specifically. A user-domain `defaults write com.anthropic.claudefordesktop` populates the CFPreferences search list but is not shown to set `isManaged:true`; treat it as unproven for first-launch forcing. The **managed plist (via `.mobileconfig`) is the reliable lever.**

### H3. Recommended fix
*Validation status: the **configLibrary writer** (the no-admin fallback
below) is validated end-to-end incl. clean-room (§H5). The **`.mobileconfig`**
is generated and `plutil`-valid but its install was not tested here (needs
GUI/MDM on macOS 26). Both are implemented in `src/lib/claude-desktop-3p-config.ts`.*

**Primary — emit a `com.anthropic.claudefordesktop` `.mobileconfig`
managed-preferences profile** (instead of writing `claude_desktop_config.json`):
- Read regardless of the `-3p` userData dir → sidesteps the path bug (H1).
- Highest precedence → survives corporate MDM (A3); can't be shadowed.
- Forces first-launch 3P with **no Anthropic sign-in / no account** (H2).
- Makes the config read-only → no drift (fixes D2 by removing the file-tier
  toggle-state guessing entirely).
- Payload keys: `inferenceProvider:"gateway"`, `inferenceGatewayBaseUrl`,
  `inferenceGatewayApiKey`, `inferenceGatewayAuthScheme:"bearer"`,
  `disableDeploymentModeChooser:true`, `coworkEgressAllowedHosts:["*"]`,
  `allowedWorkspaceFolders`, telemetry toggles. (`inferenceModels` not
  required — Section G.)

Delivery:
- **Managed fleets (likely report source):** ship the `.mobileconfig` via
  Intune/Jamf. This is the answer for the corporate case.
- **Solo / unmanaged:** install the same profile once via `sudo profiles
  install -path maximal-claude-3p.mobileconfig` (or System Settings →
  Profiles). Non-developer, zero-drift; needs admin once.
- **No-admin fallback:** write `Claude-3p/configLibrary/<uuid>.json` +
  register in `_meta.json` (replicates Developer Mode). Works without
  admin, but it's file-tier (shadowed by any managed profile) and must
  track the `-3p` suffix per build — so it's a fallback, not the default.

**Do not** rely on the in-app Developer Mode (manual, per-machine,
unautomatable) and **stop writing `~/Library/Application Support/Claude/claude_desktop_config.json`**
(wrong dir for current builds).

### H4. Toggle-off / revert behavior — validated (2026-06-22)
Standard (1P/personal) and 3P run out of **separate userData dirs**
(`Claude/` vs `Claude-3p/`), so enabling 3P never overwrites the personal
login — it parks it. 3P is gated purely on `inferenceProvider` (binary:
`const e=A.inferenceProvider; if(!e) return null`). Verified live: after
running the revert (delete applied profile, blank `_meta.appliedId`, clear
top-level `deploymentMode` → `inferenceProvider` absent from every tier)
and relaunching, the app did **not** log `3P mode active`; it navigated to
`https://claude.ai/` and landed on `claude.ai/login` — i.e. it cleanly
exited 3P into standard mode. For a user with a real subscription, the
personal session (held in the separate `Claude/` dir) returns; if it
lapsed they just re-authenticate (the subscription is account-side).
**Caveat:** this clean revert only holds when 3P was wired via the
file/`defaults` tier. A **managed `.mobileconfig`** can't be removed by
maximal's toggle (no admin/MDM), so toggle-off is a no-op there — the app
stays forced in 3P until the profile is uninstalled. The app ships a
`--boot-1p-once` flag as an escape hatch if a persisted `deploymentMode`
ever makes it stick.

### H5. Clean-room validation — config is self-sufficient (2026-06-22)
To rule out the earlier success riding on the host's prior Developer-Mode
setup, both userData dirs (`Claude/` + `Claude-3p/`) were moved aside —
removing Developer Mode (`developer_settings.json`), the provisioned
identity, and all caches — and **only** our config written into a fresh
`Claude-3p/`. On relaunch it booted clean:
`Credentials loaded from enterprise config { provider: 'gateway' }` →
`3P mode active` → a **newly auto-provisioned** local identity
(`accountId=853d6798…`, distinct from the prior `96afa066…`,
`existingSessions=0`, synthetic `orgId=00000000-0000-4000-8000-000000000001`)
→ `Model discovery: 7 found` — no sign-in, no setup prompt, no Dev Mode.
Conclusions: (a) the app **auto-creates** the local Cowork-3P identity on a
clean 3P boot — no pre-provisioned account needed; (b) the boot-time
`[enterpriseConfig]` read is **not** gated on Developer Mode (`allowDevTools`
only gates the in-app authoring UI / DevTools menu); (c) the build redirects
userData to the `-3p` dir via `app.setPath("userData", …)` unconditionally.
The configLibrary writer is therefore self-sufficient from scratch.

## F. Anthropic documentation cross-check (2026-06-22)

Sources (all official; the Help-Center URLs in maximal's MDM doc have
moved): `claude.com/docs/cowork/3p/configuration`, `/installation`,
`/overview`. Feature status verbatim: **"Beta. Cowork on 3P is under
active development."** No minimum Claude Desktop version is documented.
Confirmed by independent WebFetch ×3 + WebSearch.

### F1. Config PATH discrepancy — CONFIRMED as the defect ✅ (see §G/§H)
- **Docs (current):** macOS gateway config lives in a **directory**,
  `~/Library/Application Support/Claude-3p/configLibrary/`, holding one
  `<id>.json` per saved profile plus a `_meta.json` that records which
  profile is applied. Authored by the **in-app Developer-Mode window**
  ("Help → Troubleshooting → Enable Developer Mode → Developer → Configure
  third-party inference") or pushed via an MDM `.mobileconfig`. The docs
  **never** reference `claude_desktop_config.json`.
- **maximal (code):** writes a single flat file
  `~/Library/Application Support/Claude/claude_desktop_config.json`
  (`src/lib/claude-desktop-config.ts:132-145`) — historically the
  **MCP-server** config file, a different directory.
- **Implication:** if current Claude Desktop reads inference-gateway
  settings only from `Claude-3p/configLibrary/`, maximal's write is inert.
  This is the cleanest explanation for "toggle ON, nothing happens."
- **Confirmed (§G/§H):** verified on a working host — the live app reads
  `Claude-3p/configLibrary/`, the classic `Claude/` file is inert. maximal's
  path worked at integration (MDM doc 2026-05-04) because Anthropic moved
  the format mid-beta; there is no legacy fallback. The fix (write to
  `Claude-3p/configLibrary/`) was then validated end-to-end, including a
  clean-room run.

### F2. `deploymentMode` is not in the official schema
- Docs activate third-party mode purely by the **presence of
  `inferenceProvider`** ("Setting this key activates third-party mode";
  "when unset … normal Claude.ai sign-in"). The documented lever to hide
  the Claude.ai sign-in is **`disableDeploymentModeChooser: true`** (which
  maximal already sets). No `deploymentMode` key exists in the reference.
- maximal writes `deploymentMode:"3p"` and treats it as the sign-in gate
  (`claude-desktop-config.ts:101-109`). Either undocumented-but-real
  (reverse-engineered) or a no-op. At minimum, our A4 analysis should lean
  on `inferenceProvider` presence + `disableDeploymentModeChooser`, not
  `deploymentMode`.

### F3. `inferenceModels` — NOT required ❌ (struck; was a wrong concern)
- Initial reading of the docs suggested `inferenceModels` might be needed
  to populate the picker. **Disproven empirically:** the working host's
  profile has no `inferenceModels`, and the clean-room boot discovered 7
  models purely from the gateway's `/v1/models` (`Model discovery: 7 found`).
  So the gateway's own listing is sufficient; omit the key. (`inferenceModels`
  remains an optional allowlist if you want to *restrict* the picker.)

### F4. Precedence / scoping corrections to Section A
- **Managed-wins-over-file: CONFIRMED verbatim** — "When a managed source
  is present, it wins and locally written values are ignored." macOS
  managed source = `/Library/Managed Preferences/<user>/com.anthropic.claudefordesktop.plist`
  (domain `com.anthropic.claudefordesktop` — confirmed correct). So A3 is
  real, but tighten it: the "server-managed" tier above MDM is **not
  documented** (drop/caveat it), and "registry" is **Windows-only** (split
  the ladder per-OS; macOS has no registry tier).
- **Restart-at-launch: CONFIRMED verbatim** — "Configuration is read once
  at launch, so fully quit and reopen the app after any change." Validates
  A1 directly. Note "fully quit" includes any menu-bar/tray instance.
- **`coworkEgressAllowedHosts` scope correction:** docs say it affects
  **tool calls only** — "Inference and MCP traffic are covered by their own
  allowlists elsewhere" — and "IP literals and localhost always resolve
  regardless of this list." So it is **not** an inference blocker and a
  `127.0.0.1` gateway is always reachable. The MDM-egress clearing in
  `configure-claude-desktop.ts` is about Cowork connector egress, not about
  reaching maximal. (Our earlier macOS-audit item "MDM egress blocks
  loopback" is therefore **incorrect** — strike it.)

### F5. Endpoint / auth contract (confirmed)
- Gateway must speak the **Anthropic Messages API** (`/v1/messages`) and
  serve a **`/v1/models`** listing; the in-app option is labeled "Gateway
  (Anthropic-compatible)". It is **not** OpenAI-compatible. maximal serves
  both (Section B/C), so this is fine — but model IDs must line up with F3.
- `inferenceGatewayAuthScheme` accepts `bearer` (default) or `x-api-key`;
  maximal's `bearer` + `"anything"` is valid per schema (enforcement is a
  maximal-side concern — B4).
- `inferenceProvider` documented values are six: `gateway`, `anthropic`,
  `bedrock`, `mantle`, `vertex`, `foundry` (maximal's `gateway` is correct).

### How to confirm F1/F2 on an affected Mac (non-destructive)
```sh
# Does current Claude Desktop use the new config-library path?
ls -la ~/Library/Application\ Support/Claude-3p/configLibrary/ 2>/dev/null
cat   ~/Library/Application\ Support/Claude-3p/configLibrary/_meta.json 2>/dev/null
# What maximal actually wrote (classic path):
cat   ~/Library/Application\ Support/Claude/claude_desktop_config.json 2>/dev/null
# Is a managed profile shadowing everything? (the A3 case)
ls -la /Library/Managed\ Preferences/*/com.anthropic.claudefordesktop.plist 2>/dev/null
defaults read com.anthropic.claudefordesktop 2>/dev/null
# Claude Desktop version (schema/path may be version-gated):
defaults read /Applications/Claude.app/Contents/Info CFBundleShortVersionString 2>/dev/null
```
On a **working** machine, expect `Claude-3p/configLibrary/` populated and a
selected profile in `_meta.json`. *(This was run: the working host had
exactly that — see §G — confirming F1. Useful as a field triage script for
*broken* machines: if `Claude-3p/configLibrary/` is empty/absent while
`Claude/claude_desktop_config.json` has our keys, the user is hitting the
path bug.)*

### Note for Microsoft-managed devices
Anthropic publishes `learn.microsoft.com/.../configure-claude-desktop` for
the **Foundry** provider. A Microsoft-managed Mac may have an Intune-pushed
`com.anthropic.claudefordesktop` profile (e.g. `inferenceProvider:foundry`)
that, per F4, **shadows** maximal's `gateway` file write entirely — the
strongest form of A3 for this specific audience.

## Highest-leverage fixes to consider

0. **Write to the right place (THE fix — built + validated).** Replace the
   `Claude/claude_desktop_config.json` write with the `Claude-3p/configLibrary/`
   writer (`src/lib/claude-desktop-3p-config.ts` → `applyConfigLibraryProfile`),
   and/or emit the `.mobileconfig` (`generateManagedProfile`) for managed
   fleets. Telemetry off + updates on are baked in. This is the actual root
   cause; everything below is secondary hardening. Remaining: wire into the
   toggle route + CLI, fix `enabled`/`alreadyConfigured` to read the 3P
   config library, surface the managed-vs-file "off" asymmetry (§H4), tests.
1. **Restart nudge**: after a successful toggle, detect a running Claude
   Desktop and prompt "Quit & relaunch Claude Desktop to apply" (or offer
   to do it). Closes A1 — the single most common silent failure.
2. **MDM-tier awareness**: read the managed/defaults tier for *all* routing
   keys (not just `coworkEgressAllowedHosts`); if a higher tier shadows the
   file, warn explicitly with the exact `defaults`/profile remediation.
   Closes A3/A4 for managed Macs.
3. **Surface "configured but not effective"**: have the toggle/Settings
   verify reachability (`GET /setup-status` + a probe completion) and the
   *effective* deploymentMode, not just file equality. Catches A4, B1-B4,
   C1-C2 at the moment the user flips the switch instead of inside Claude
   Desktop's opaque error UI.
4. **Onboarding**: from `maximal setup`, when Claude Desktop is detected,
   offer to run the pairing inline rather than printing a CLI hint (A2).
