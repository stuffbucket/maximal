# Single-window redesign — design spec

Status: Proposed, 2026-07-14. UI delivery committed to **browser-tab** (see
*Architecture decision*).
Owner: bstucker.
Scope: Collapse the app to **one UI surface** opened by a **single tray
click**. The UI is served by the sidecar into the user's **browser tab**; a
thin Tauri layer provides the tray, the sidecar supervisor, and a native
boot/failure window (the splash). The one window absorbs everything the tray
menu + the separate Settings/Dashboard windows did, and the left nav is
architected to scale as new content (notably **per-project tracking**) enters
it later without a re-architecture.

This spec is the synthesis of ~15 parallel investigations across design
(`docs/design/*` + the `design-*` skills), browser-platform feasibility
(six spikes, including two empirical on-host tests in Safari + Edge), a
security audit, and five repo-grounded verification passes. Where a claim was
measured, it is marked **[spike]**. File:line citations point at the code the
implementation will touch.

## TL;DR

- **Tray = one click, no menu.** The click tells the **sidecar**, which owns
  the browser tab: a visible tab → no-op; a buried tab → command it to
  `window.close()` over a WebSocket, then open one fresh foreground tab; no
  tab → open one. Single tab, focused, every click — **measured in Safari and
  Edge [spike]**. No PWA, no service worker, no native scripting.
- **The UI is a sidecar-served browser page.** DevTools, extensions, and the
  user's browser for free; no bundled-webview quirks.
- **A thin Tauri layer stays** for the tray, sidecar spawn/supervise/kill, and
  the **native splash** (boot + failure recovery — it must survive a dead
  sidecar, which can't serve a tab).
- **One Bun-native WebSocket** (through srvx's `bun:{websocket}` passthrough —
  **no crossws** [spike]) carries the presence registry *and* the unified live
  feed (auth / usage / update / health), replacing today's SSE + Tauri
  `Channel` + Rust `emit`.
- **Hard invariant: `history.length === 1`** (`replaceState`-only routing) or
  stale-tab self-close silently fails **[spike]**.
- **Instant paint:** the sidecar inlines current state into the served HTML
  (`window.__STATE__`) — populated first frame, no evictable client storage.
- **A separate read-only diagnostics page** (`/ui/diagnostics`) is the safe,
  free-to-open browser debug affordance. The app UI has **no** debug
  special-casing.
- Dashboard → a React **Usage** section; scalable 4-group nav + a bounded
  **Projects** slice; in-page auth chip + update banner; **control-surface
  hardening** (mandatory once the UI is a real browser origin).

## Architecture decision — browser tab, not a Tauri webview

Committed after six spikes. The short rationale of record:

- **Browser delivery is empirically viable.** A tray click routed through the
  sidecar closes a stale tab over the WS and opens one fresh foreground tab —
  measured to produce exactly one focused tab in **Safari and Edge [spike]**.
  The earlier objection ("tray clicks must stack duplicate tabs; scripts can't
  focus foreign tabs") was disproven for this design.
- **No PWA, no service worker, no native scripting.** PWA `launch_handler` is
  Chromium-only and install-gated; service workers carry Safari ITP-eviction
  and stuck-worker risk; AppleScript focus-or-open needs a per-browser macOS
  Automation (TCC) grant (hard-denied with no prompt on the test host [spike])
  and dies on Firefox/off-mac. All excluded. The design needs **none** of them
  — the WebSocket is the only primitive, and it's the most battle-hardened one
  in the browser.
- **The costs are bounded and mostly things we'd do anyway:** the
  `replaceState` routing change, net-new WS wiring (zero new dependency —
  Bun-native through srvx [spike]), and the control-surface hardening (a real
  latent hole regardless — see §6).
- **Known-degraded corners** (accept, don't chase): a long-backgrounded Safari
  tab whose WS was torn down (~5 min) can briefly duplicate and **self-heals**
  on refocus; Firefox/Windows/Linux are unverified on this host — treat as
  degraded-but-probably-workable pending a spike.

Not chosen: the Tauri webview (single-window/focus/splash for free, but
WKWebView/WebView2 quirks and no extensions/DevTools) and an earlier
iframe/local-shell design (over-engineered — recovery moving to the native
splash deletes it).

## Goals

1. One UI surface (a browser tab), opened by a single tray click, no menu.
2. Recovery (Retry / Show logs / Reveal config / Quit) works **even when the
   sidecar is down** — via the tray + the native splash.
3. Everything the tray menu advertised — auth status, update availability — is
   surfaced in the UI.
4. The Dashboard becomes a section of the one UI, on the shared design tokens
   (kills the two-design-system drift).
5. The left nav is designed **now** to absorb a growing, dynamic set of tracked
   projects without a later re-architecture.
6. A safe, read-only diagnostics page replaces ad-hoc "open the app UI to
   debug."
7. Close the control-surface CSRF hole (mandatory once the UI is a browser
   origin).

## Non-goals

- Building per-project tracking itself (no `project_id` attribution exists yet
  — see §5). This spec locks the **nav architecture** the feature slots into.
- A Tauri-webview or installed-PWA delivery (evaluated and not chosen).
- Responsive/mobile layout. Desktop-only.
- Binding `Cmd-K`. It stays reserved; the design plans *around* it.
- Any debug exemption inside the app UI (the read-only diagnostics page is the
  affordance instead).

---

## 1. Window & shell architecture

### 1.1 Three surfaces

- **The app UI — a sidecar-served browser tab** at `http://localhost:<PORT>/ui/settings`.
  Served as static bytes from an unauthenticated `/ui` prefix
  (`src/routes/ui/route.ts`), it carries an inlined session token + state so it
  is fully functional loaded straight from that URL.
  **`<PORT>` is the sidecar's *discovered bound port*, not a literal `4141`** —
  `dev` binds `4242`, and `beta` / `--port` / ephemeral `:0` fallback all exist
  (see the beta-channel doc's `runtime.json` port-discovery seam). The tray's
  open-URL and the WebSocket endpoint (§1.3) must both derive from the actual
  bound port; a hardcoded `4141` breaks the `dev`/`beta`/`--port` channels.
- **The native splash / boot / failure window** — the existing
  `WebviewUrl::App("splash.html")` window (`create_splash`, `lib.rs:1509`),
  Tauri-bundled and **sidecar-independent**. It covers the boot gap, shows live
  boot status + the failure reason, and hosts the recovery actions. A dead
  sidecar can't serve a browser tab, so recovery must live here.
- **The tray** — single click, no menu; a state-driven icon + tooltip stay.

### 1.2 Tray → sidecar-mediated open (the single-tab core)

The tray click does **not** call `open URL` directly; it signals the sidecar,
which holds a WebSocket to each open tab and a presence registry keyed by a
client-generated `tabId` (persisted in `sessionStorage`) with each tab's
`visibilityState`. The decision (a pure read over the registry):

- **A visible tab is connected** → no-op (a background page can't be raised
  anyway — `window.focus()` is a no-op **[spike]**; a visible one is already
  shown).
- **Only buried tab(s)** → send `{cmd:close}` over the WS (self-closes in
  ~100–150 ms on a single-history tab, **Safari + Edge [spike]**), then open
  one fresh tab (`open URL` lands it foreground **[spike]**).
- **No tab** → open one.

Registry correctness rests on an **identity-checked delete**
(`if map.get(id) === ws`) so a reconnecting tab's new socket isn't deleted by
the old socket's late `close`. A **single-flight guard** collapses rapid
double-clicks to one open.

Rust changes (`shell/src-tauri/src/lib.rs`): in `install_tray` (`:1664`) remove
`.menu()` + `.on_menu_event()`, route left-click (both platforms) to
`open_app(state)`; **delete** `mod menu_id` (`:120`), `build_menu` (`:1820`),
`handle_menu_event` (`:1973`), and the accelerators; **keep** `icon_for`
(`:1766`) + `tooltip_for` (`:1792`); `refresh_tray` keeps only
`set_icon`/`set_tooltip`. `single_instance`'s focus/no-dup guarantee (`:614`)
moves to the sidecar registry.

### 1.3 One Bun-native WebSocket (no crossws)

srvx 0.11's `bun:{ websocket }` option flows straight to `Bun.serve`, and the
Bun `server` handle is decorated on every request, so one Hono route calls
`server.upgrade(...)` — **no crossws, no srvx fork, zero new dependency
[spike]**. It replaces three transports: SSE `/settings/api/events` (auth),
the Tauri `Channel` `subscribe_token_usage` (usage, `lib.rs:541`), and Rust
`emit` (state). It carries the presence registry *and* the unified live feed.
**The feed must carry every event type ADR-0007's SSE defined — `auth.changed`,
`accounts.changed`, `apps.changed`, `clients.changed`, `upstream.rejection`,
and `boot.state` (account-switch reboot)** — plus the new `usage`,
`update-available`, and `sidecar-health` events. (An earlier draft listed only
auth/usage/update/health; the Accounts, Apps, and API-clients sections still
consume the other three, and the account-switch reboot flow — `architecture.md:45`
— emits `boot.state`. Dropping them orphans those sections when the polling
shell is deleted.) Requirements: loopback-only + path-scoped `?key=` auth (a
browser WS can't send `x-api-key`; the `SSE_EVENTS_PATH` `?key=` allowlist in
`request-auth.ts:133-159` must **move** to the WS path — it is a single
hardcoded path today); heartbeat/ping-pong liveness; reconnect-on-`visible`
with bounded backoff; and a **complete snapshot on (re)connect** so a resumed
tab resyncs without a poll. The endpoint is on the **discovered bound port**
(§1.1). This is a **multi-subscriber** feed (N app tabs + N read-only
`/ui/diagnostics` pages), reversing ADR-0007's "one shell, one connection"
scope.

**The one gate to prove first:** srvx's fetch-wrapper must tolerate the
`undefined` return after `upgrade()`; if it coerces it to a `Response` the
handshake silently fails. Fallback: a srvx plugin that upgrades before Hono.

### 1.4 Single-history invariant + instant paint

- **`history.length === 1`.** All in-app nav via `history.replaceState` — never
  `pushState`, never `location.hash =` (both accrue history; a second entry
  makes stale-tab `window.close()` **silently no-op in Safari and Edge
  [spike]**). The `#section` deep-link contract may remain if navigation stops
  *assigning* `location.hash`. Today's routing is hash-driven (`main.ts:61-92`,
  `:2104-2125`) and must move to a single `navigate(id)` that also absorbs the
  `hashchange`-driven side effects.
- **Instant paint.** The sidecar inlines current state into the served
  `/ui/settings/index.html` (`window.__STATE__=…`, `<`-escaped against
  `</script>` breakout) so the tab paints populated on first frame; the WS then
  takes over. No `localStorage`/`indexedDB` on the first-paint path (Safari ITP
  evicts them). The hook is `serve()` in `src/routes/ui/route.ts`.
- **Move the locale override off `localStorage`.** Today `resolveLocale()`
  reads `localStorage["maximal.locale"]` *at load, before first paint*
  (`i18n.md`) — the one existing first-paint client-state dependency in the
  ITP-evictable store. Under browser delivery, eviction silently resets the
  user's language to the `navigator.languages` default. Persist the chosen
  locale **server-side and inline it into `window.__STATE__`** (same treatment
  as the update-banner dismissal, §3.2), or explicitly accept the reset.

### 1.5 No `window.__TAURI__` in the browser UI

A browser tab has no Tauri host, so every `invoke()` becomes a sidecar HTTP/WS
call: `get_shell_api_key` → minted token in the served HTML; `reveal_logs_dir`
/ `reveal_config_dir` / `restart_sidecar` → recovery lives in the native splash
(§3.3), not the browser UI; `uninstall_maximal` stays **IPC-only** (§6);
`set_menu_bar_only` → a `/settings/api` route; opener → `window.open`. Net: the
browser-loaded UI has **no dead buttons** (an improvement over today, where
those `invoke`s silently fail outside Tauri).

### 1.6 Quit reachability

Deleting the tray menu deletes the only Quit + `Cmd-Q`. Re-provide **both**, in
the same PR: a macOS **app menu** Quit (`app.set_menu` in `setup`) and a
**`quit_app`** command wrapping `request_quit` (`:2473`), exposed as a Quit
button in the native splash (the always-available path — the app menu is absent
in `Accessory` mode with no window). Window close still hides; the
`ExitRequested` veto (`:748`) keeps the tray alive.

### 1.7 Read-only diagnostics page (`/ui/diagnostics`)

A standalone, **read-only, mutation-free** page — the safe browser debug
affordance, replacing the habit of opening the app UI to poke at state. It is
CSRF-safe *by construction* (no mutations to protect), free to open in any
browser (open as many as you like — it does **not** participate in the
tray/dedup/WS-registry flow), and shows: effective config + secret **sources**
(never values, like `maximal debug`), sidecar health/state, read-only auth
status, model list, a usage snapshot, version/update status, and the **raw
state tree** (the debug view we're removing from Usage — §4). It renders the
same data as `maximal debug --json` and `GET /_debug/state`. Served under `/ui`
(unauthenticated, read-only GETs only). Name is provisional.

---

## 2. Information architecture — the scalable left nav

### 2.1 The scaling problem

Nine fixed config sections are a **closed set**; projects are an **open,
unbounded** entity set. The rail is narrow and one-row-tall per item
(`components.md`); the config sections alone nearly fill it at minimum height.
An unbounded project list appended to that overflows. `windows.md`'s test —
*"would a user need to jump to a specific section by name?"* — says frequent
projects belong in nav, the 43rd belongs in search. So projects are **both**,
split by frequency.

### 2.2 Decision: bounded rail slice + master-detail spillover

The rail carries a **Projects group with a hard-capped ~6-item curated slice**
(pinned/recent) + an **"All projects"** entry; the complete, unbounded set
lives in the **content pane** as a master-detail view. The rail is a **shortcut
bar, never an index** — completeness is delegated to the content-pane search and
the reserved `Cmd-K`. At 3 projects it shows 3; at 50 it shows ~6 + "All
projects" and the rail height stays constant (the 30-item flat list is
structurally impossible). "All projects" = the cross-project overview; a rail
row or master-detail row = one project.

### 2.3 Rail layout

Four groups (brand mark on top = the window's one Fraunces moment):

```
  m
  YOUR ACCOUNT      Account · Usage
  PROJECTS          All projects · <curated slice, ~6 max>
  CONNECT YOUR TOOLS Endpoint · API clients · Apps · Models
  APP               General · Logs · Diagnostics
```

Slice rule: ≤6 → show all; >6 → 6 (pinned first, then recent) + "All projects".
No search field in the rail. Empty state (no projects): only "All projects",
whose content view is a teaching empty state pointing at API clients. Default
landing: dynamic — Account when signed-out, Usage when signed-in (D1).

### 2.4 A single project's detail = Usage, scoped

"All projects" hosts a master-detail in the content pane; the **detail is the
ported Usage view with a project filter** — same components, one query param.
Usage and a project detail are the same view at two scopes.

### 2.5 Active-nav & routing

Active state = a rounded surface step (never `--brand` crimson, never a left
bar); project rows differ only by a leading monogram; `:focus-visible` only;
projects get no display type. Routing uses `replaceState` (§1.4): `#projects`
→ All projects; a project detail via an **open-time param** (`?project=<slug>`)
+ `replaceState` for in-app moves — never hash-accruing nav. The slug is stable
(API-key label), never the hashed `session_id`.

---

## 3. Status surfaces — auth, update, recovery

Split by health: the **auth chip and update banner live in-page** (they matter
when the sidecar is up to answer for them); **failure recovery lives in the
native splash** (it matters when the sidecar is down). Status color tokens
(`--status-*`) already exist in `tokens.css` (the `failure-modes.md` drift table
is stale — fix separately).

### 3.1 Auth chip (in the app UI)

Header chip, deep-links to `#account`, reads the **unified WS feed** (§1.3).
Signed in → avatar + "Signed in as {login}" (the real login, unlike the tray).
Signed out → `--status-warning` dot + a **Sign in** CTA. Degraded (recent
upstream rejection) → dot flips to warning. This supersedes the section-scoped
SSE subscription (ADR-0007) with one page-lifetime feed (update ADR-0007).

### 3.2 Update banner (in the app UI)

"Update", not "upgrade" (no paid tier). Triggered by `LatestUpdate` over the WS;
shown only when healthy. A dismissible info-banner strip: "Maximal {latest} is
available" + **Get the update** (`open_update_url`) + ×. Dismissal is
per-version; store it server-side / in `__STATE__` (not `localStorage`, which
Safari evicts).

### 3.3 Failure recovery (in the native splash)

Driven by `SidecarState` over the existing `splash:*` emits. `Starting` → quiet
progress (reduced-motion → static). `Failed`/`Stopped` → a warn-styled banner
(`--status-warning`, not alarmist), the failure reason as body, and buttons
calling **existing native commands**: Retry → `restart_sidecar` (`:2610`), Show
logs → `reveal_logs_dir` (`:2559`), Reveal config → `reveal_config_dir`
(`:2552`), Quit → `quit_app`. **Fix the latent bug:** the splash's 12 s
auto-dismiss on `Failed` (`:1578`) must hold until the user acts, or it eats the
recovery UI.

### 3.4 i18n

New chip/banner/recovery strings get `en.json` keys (+ the full base locale) per
`docs/dev/i18n.md`; ICU args never concatenated; the parity test enforces cross-
locale coverage. Loop in the i18n expert (`CONTRIBUTORS.md`) before landing
copy.

---

## 4. Dashboard → Usage port

The dashboard is pure presentation over three fetches (`/usage`,
`/token-usage`, `/token-usage/events`) — CSS meters + HTML tables + stat tiles,
**no chart library**. Porting it into the React SPA as a "Usage" section (the
island convention of `Models.tsx`) drops Tailwind/Lucide — a **net bundle
reduction**. Keep the endpoints on their **exact paths** (the project filter is
a query param) so the loopback auth exemption still applies. Token
reconciliation: drop the dashboard's drifted `--color-*` aliases, resolve to
canonical semantic tokens in both light/dark; the two tokens with no canonical
equivalent (`--color-purple-accent`, the `renderError` rgba) get a real token or
a documented new one; `--text-xs` on labels/cells must resolve to `--text-sm` or
a justified allow-rule (it collides with the existing `.kbd`-only token gate).
**Drop the raw JSON tree** from Usage — it moves to the read-only diagnostics
page (§1.7). Retire the Rust `Channel`; the WS feed drives Usage's live updates.

---

## 5. Forward-plan: the projects data layer

No `project_id` exists today, and `session_id` is the wrong axis (ephemeral,
high-cardinality — would flood the rail). The durable key is the **API-key
label** (`settings-types.ts:264`). Forward-looking (not built now): ship a
**nullable `project_id` column** on the existing append-only migration
framework (`store.ts:200`) so the schema/filter/route exist before the feature
turns on; populate from `api_key_id` first (thread the authenticating key into
`TokenUsageEventInput`); later from a client-supplied `workspace` header. Never
ship "project = `session_id`."

---

## 6. Control-surface hardening (mandatory under browser delivery)

The `/settings/api/*` surface is **already CSRF-exposed today**: auth is off by
default (`request-auth.ts:184-237`), no Origin check anywhere, `cors()` is `*`
(`server.ts:50`), loopback gating is source-IP-only. A real browser origin makes
it exploitable, so this ships **with** the redesign (it should be fixed
regardless):

1. **Origin/Referer allowlist on `/settings/api/*` — and on `/_internal/*`**
   (`Origin` is a Forbidden header — JS can't forge it — so this blocks all
   browser-driven cross-origin calls), independent of `enforce`.
   **`POST /_internal/shutdown` is the same hole** (`src/routes/internal/route.ts:41`):
   it's loopback-gated + auth-exempt, so a malicious page's `fetch` from the
   user's local browser (source IP = loopback) can shut the sidecar down. The
   allowlist must cover it; `/_debug/state` (read-only) should too.
2. **Mandatory auth on `/settings/api/*`, decoupled from the `enforce` toggle.**
3. **Tighten `cors()`** from `*` to a localhost allowlist (the `OPTIONS`
   preflight is the load-bearing case — auth bypasses it).
4. **Destructive/irreversible ops stay native/IPC-only** — uninstall already is;
   consider `accounts/remove` + `api-keys/enforce` too.
5. **A minted session token** in the served `/ui` document (same-origin-readable
   only) replaces the Tauri-IPC shell-key handoff a browser tab can't reach; the
   WS authenticates with it. The read-only diagnostics page (§1.7) needs none of
   this — it mutates nothing. (Clarify whether the per-launch `state.shellApiKey`
   survives as this token's source or is itself replaced — ADR-0003.)
6. **Invariant — must not regress the CLI/plugin clients.** Claude Code,
   opencode, and SDK clients are non-browser callers that send **no `Origin`**
   and hit `/v1/*`, `/responses`, `/chat/completions`, `/v1/models`,
   `/embeddings` + the `api claude-code` key mint — not `/settings/api`. The
   Origin gate (missing-Origin passes), the `enforce`-decoupled mandatory auth
   (must keep honoring their `Authorization: Bearer <key>`), and the narrowed
   **global** `cors()` must all leave those routes reachable. Add a regression
   test asserting a no-Origin `Bearer` request to `/v1/*` still succeeds.

---

## 7. Removal & migration touchpoints

- **Windows collapse to the tray + splash only.** Delete
  `open_settings_window`/`open_dashboard_window` (`:2061`, `:2276`), the
  settings/dashboard window labels (`:105-106`), `RunEvent::Reopen` webview
  logic (`:778`), and the webview-open paths; the splash window stays. The tray
  gains `open_app` (signal the sidecar); add `quit_app`.
- **Dashboard removal:** `shell/ui/dashboard/` + `shell/src/dashboard/main.ts`
  (after porting), `buildDashboard()` in `scripts/build-ui.ts`, the `/ui/dashboard`
  route + the `/usage-viewer` redirects. **Keep** the data endpoints
  (`/usage`, `/token-usage`) and their loopback block. Retire
  `subscribe_token_usage` + `TokenUsageEvent`. `/ui/dashboard` is gone (content
  lives at `/ui/settings?section=usage`); no redirect (per "no exceptions").
- **Transport migration:** WS replaces SSE `/settings/api/events` + the Tauri
  `Channel` + Rust `emit`, carrying **all six ADR-0007 event types** (§1.3), not
  just auth. The `SSE_EVENTS_PATH` `?key=` allowlist moves to the WS path.
- **New sidecar routes** replace former Tauri invokes (`reveal_*`,
  `restart_sidecar` stay native/splash; `set_menu_bar_only` → `/settings/api`).
- **i18n key sweep (do in one commit or CI reds):** delete the orphaned
  `native-tray-*` (10) + `native-window-*` (3) keys from **all 12 catalogs**
  (the lib.rs-reference test won't warn you — only the stray-key parity test
  will); new keys must land in **all 8 full-coverage locales**, not just `es`;
  decide `native-tray-quit`'s fate (kept for the app-menu Quit vs deleted); fix
  the stale `native-quit-body` copy; add the i18n runtime to `splash.html`
  (none today) and route Show-logs/Reveal-config through the `{fileManager}`
  ICU noun.
- **Docs to update — see §11** for the full, audited list (it is much larger
  than "windows.md + ADR-0007": four PRDs, two wire specs, `architecture.md`,
  ~six ADRs, five design docs carrying the token-duplication rule, and the
  repo-wide `shell/src/tokens.css` → `shell/src/ui/styles/tokens.css` path
  correction).

---

## 8. Decisions

**Resolved:** D8 → browser-tab delivery (committed). WS is core (not optional).
D3 → retire the Rust `Channel`. D4 → drop the raw JSON tree from Usage (moves to
`/ui/diagnostics`). D5 → app-menu Quit + splash Quit button. D7 → superseded by
the read-only diagnostics page. Debug affordance → `/ui/diagnostics`, no app-UI
exceptions.

**New ADRs (drafted):** **ADR-0018** browser-tab delivery; **ADR-0019** WS
transport + presence registry (supersedes ADR-0007's WS rejection *and* its
single-subscriber scope — ADR-0007 marked `superseded`); **ADR-0020** the
single-history `replaceState` invariant (amends ADR-0002/0004's hash-nav);
**ADR-0021** control-surface hardening (Origin allowlist + mandatory
`/settings/api` auth + `/_internal` coverage). ADR-0008 (token SSOT) marked
`obsoleted` (the dashboard duplicate it synced is deleted).

**Open (recommendations noted):**
- **D1 — default landing:** dynamic (Account signed-out / Usage signed-in).
- **Firefox / Windows / Linux parity:** unverified on this host. Spike before
  claiming support, or ship macOS-Chromium/Safari-first and note degradation.
- **`/ui/diagnostics` name + contents** — resolve the collision with the
  existing in-app Diagnostics section (`nav-diagnostics`/`diagnostics-*` keys);
  cite ADR-0010's `getEffectiveConfig()` as its backend.
- **`/activity` feed** (from the old dashboard PRD): reconcile onto the WS as an
  event type, or explicitly scope out — don't leave it silently dropped.
- **"Works offline"** (settings PRD non-goal): re-scope to "works on loopback
  with the sidecar up" (the UI now depends on a live WS + inlined state).
- **First-run onboarding:** re-home into the Account section + native splash;
  the `/setup-status` + `/auth/*` contracts survive and must be consumed.
- **Update-banner source:** the Phase-6 `update-check.ts` detector, surfaced as
  the WS `update-available` event.

---

## 9. Build sequence

1. **Security hardening (§6)** — independent; ship first (closes a live hole).
2. **WS core (§1.2–1.3)** — prove the srvx-upgrade gate first; then registry +
   orchestration + reconnect. Blocks the live feed.
3. **Tauri shell (§1.2, 1.6, 3.3, 7)** — tray/open/splash-recovery/quit;
   parallel with 2. Fix the splash auto-dismiss + quit-reachability bugs here.
4. **SPA (§1.4–1.5, 3.1–3.2)** — `replaceState` refactor + single-history gate +
   instant-paint + chip/banner on the WS feed + de-Tauri.
5. **Usage port + nav + projects (§2, 4, 5)** — depends on 4's scaffolding.
6. **Read-only diagnostics page (§1.7)** — small; can land anytime after 1.
7. **Cleanup & docs (§7 + §11).**

**Cross-cutting, per ADR-0012 (binding):** each new stateful flow — tray-open
dedup (visible/buried/none), WS connect/reconnect/snapshot, splash recovery
(`Starting`/`Failed`/`Stopped`), update-banner per-version dismissal — needs a
`docs/design/state-matrices/*` doc *before* its code; the transport change also
edits `account-switch.md`/`auth.md`. **Ordering note:** if ADR-0013 (split
`lib.rs`) lands first, every `lib.rs:NNNN` citation in this spec moves — re-cut
against the new modules.

---

## 10. Verification & QA

**The repo's testing reality (shapes everything).** `bun test` is the CI test
runner and *does* run; **`cargo test` is not in CI** (Rust is nearly uncovered);
there is **no DOM/jsdom harness** and **no Playwright/visual-regression** (that
stack is "aspirational, not implemented"). So the idiom is: extract logic into
**pure functions**, assert on **view-models** + **source greps** (`readFileSync`),
gate with **mutation testing** (`bun run mutate`), and honor the **`mock.module`
leak rule** (inject deps / real modules with `:memory:` DBs). Real React-render
tests are a deliberate `@happy-dom` preload investment; screenshot diffs have no
in-repo path.

**New automated gates (the quality backbone):**

| Gate | Catches | Runs in |
|---|---|---|
| Single-history **grep** + **behavioral** (fake `History`, assert `length===1`, `pushes===0`) | a `pushState`/`hash=` breaking stale-tab self-close | `bun test` (CI) |
| WS **real-port handshake** test (`srvx.serve({port:0, bun:{websocket}})`) | srvx swallowing the upgrade | `bun test` (CI) |
| Registry **identity-guard** unit + **mutation** test | tab-registry desync → dup/miss | `bun test` + mutate |
| **Self-extending** `/settings/api` route-enumeration (walks `app.routes`) | a new route bypassing CSRF/auth | `bun test` (CI) |
| CSRF regression anchor + `enforce`-decoupled auth (mutation-checked) | the CSRF hole regressing | `bun test` + mutate |
| **Token-drift gate** extended to Usage CSS (ban `--color-*`, raw hex) | design-token drift creeping back | `lint:fast` |
| **Byte-budget** on the built UI | the port secretly growing the binary | `settings-build.test.ts` |
| New **`cargo test` + clippy** CI job; push handler logic to pure `click_action`/`failure_surface_for` | Rust regressions (today: none run) | CI (new) |
| Nullable `project_id` **migration** test (`:memory:`, idempotent, back-compat reads) | migration/regression | `bun test` |
| i18n parity (existing) | untranslated new keys | `bun test` |

**Honestly manual-only** (drive via the `run`/`verify` skills + the spike's
`/report` harness; force `Failed`/`Starting` with a failing/hanging stub
binary): real macOS tray-click delivery; the quit matrix (state × window ×
menuBarOnly — prove the `Accessory`/no-window/`Failed` case can still quit via
the splash); browser foreground/background tab timing; **Safari's
long-backgrounded self-heal**; native activation-policy transitions. Cross-
browser: **Edge automated** via throwaway `--user-data-dir`; **Safari/Firefox
manual**.

**Per-workstream invariants to assert** (condensed): tray emits one signal per
click; the sidecar opens exactly one tab and closes stale ones; reconnect
delivers a full snapshot; `history.length` never exceeds 1; inlined `__STATE__`
matches the live payload contract; every `/settings/api` mutation is
Origin-gated + auth-mandatory regardless of `enforce`; IPC-only ops 404 over
HTTP; the Usage port shrinks the bundle and keeps its endpoints on exact paths;
`curateProjectSlice` caps the rail at N=0/3/6/7/50.

---

## 11. Conflicts with existing docs & decisions (audit)

A four-part read-only audit (ADRs + `architecture.md`; PRDs + `docs/spec/`;
design + i18n; dev/research/admin) checked this plan against the knowledge base.
Findings, with how the plan accounts for each. **Blockers** are logic/CI-breaking
if unaddressed; **supersedes** = amend the doc; **stale** = doc-hygiene.

### 11.1 Blockers — genuine gaps now fixed in the plan body

- **Hardcoded `4141`** (beta-channel doc). The port is discovered, not literal
  (`dev`=4242, `beta`, `--port`, `:0`). → Fixed §1.1/§1.3 (derive from bound
  port).
- **Locale override vs Safari ITP** (`i18n.md`). `localStorage["maximal.locale"]`
  is read before first paint; the plan bans first-paint `localStorage`. → Fixed
  §1.4 (move into `__STATE__`).
- **WS event-type coverage** (ADR-0007 defines six events; plan listed four). The
  Accounts/Apps/API-clients sections + account-switch `boot.state` would orphan.
  → Fixed §1.3 (feed carries all six + usage/update/health).
- **`/_internal/shutdown` CSRF** (ADR-0003). Loopback-no-auth, browser-reachable
  — same class as the `/settings/api` hole but out of §6's original scope. →
  Fixed §6.1 (allowlist covers `/_internal/*`, `/_debug/state`).
- **CLI/plugin clients must not regress** (plugins.md; `architecture.md:34`).
  No-`Origin` `Bearer` callers on `/v1/*`. → Fixed §6.6 (invariant + regression
  test).
- **i18n deletion sweep** (parity test). Orphaned `native-tray-*`/`native-window-*`
  keys must leave all 12 catalogs in one commit; new keys need 8 locales. →
  Fixed §7 (i18n sweep bullet).
- **ADR-0012 state matrices are binding** for new stateful flows. → Fixed §9
  (matrices added to the sequence).

### 11.2 ADRs to supersede / mint

- **ADR-0007 (SSE)** — not just "update." Its rationale is *reversed* ("the shell
  never needs to push state" — the presence registry §1.2 is exactly that push)
  and its "one shell, one connection" scope is *reversed* (multi-subscriber §1.3).
  **Mint a WS-transport ADR** superseding it.
- **ADR-0004 (React islands, keep hash-nav)** — §1.4's `replaceState` single-
  history *replaces* the hash-nav model ADR-0004 committed to keeping, and moves
  toward the single-React-app it rejected. Supersede; also mark its **phase 2
  (usage-viewer→shell)** done by §4.
- **ADR-0002 (api-clients island)** — its `hashchange` selectMode-reset listener
  is a §1.4 side-effect that must move into `navigate(id)`.
- **ADR-0008 (token SSOT script)** — made *moot* (its own predicted exit): §4
  deletes the duplicate it syncs. Mark obsoleted.
- **ADR-0003 (max wrapper)** — the retained `get_shell_api_key` handoff is
  replaced by §6.5's minted token; clarify `state.shellApiKey`'s fate.
- **Mint** ADRs for browser-tab delivery, the single-history invariant, and
  control-surface hardening (see §8).
- Cross-refs (no conflict): **ADR-0010** (`getEffectiveConfig()`) is the
  `/ui/diagnostics` backend; **ADR-0014** already listed "tray-only Tauri,
  dropping the Settings window" as an open conversation this realizes;
  **ADR-0015**'s deferred "shell observes sidecar death → revert base URL" has a
  home in §3.3; **ADR-0013**'s module inventory needs re-cutting (ordering note,
  §9). ADR-0006/0009/0011 reinforced.

### 11.3 PRDs superseded or broken (add to the docs-to-update list)

- **`dashboard-window-prd.md`** — superseded (window→Usage §4). Its `/activity`
  **SSE** feed is orphaned → reconcile onto the WS or scope out (§8 open item).
- **`settings-window-prd.md`** — superseded. Its **"works offline"** non-goal
  re-scoped (§8); its in-page Reveal/Restart buttons move to the splash; its
  "unauthenticated localhost-only" route posture is overridden by §6.
- **`first-run-setup-prd.md`** — Setup-window + Dashboard-bridge + tray-menu
  onboarding superseded; `/setup-status` + `/auth/*` contracts survive (§8).
- **`tauri-icons-prd.md`** — its tray-builder snippet still attaches a menu;
  drop `.menu()`/`.show_menu_on_left_click`.
- **`wire/auth-transport-wire-prd.md`** + **`wire/usage-status-wire-prd.md`** —
  the pre-hardening baselines §6 rewrites (CORS-`*`, `enforce`-off, OPTIONS
  bypass, the path-class table, the `/ui/dashboard` + SSE notes).
- **`squint-test-prd.md`** — retarget "per-window" capture at the served tab/route.
- **`observability.md`** / **`model-protocol-strategy.md`** — clean (observability's
  "leave `/usage-viewer`" stance is merely overtaken by its removal).
- **Projects `workspace` header (§5) is net-new** — Phase-7's headers are
  outbound-only; nothing to reuse, no conflict. The durable key stays the
  API-key label.

### 11.4 Design + architecture docs (stale)

- **`architecture.md`** — the Tauri-shell paragraph (`:116`) and middleware line
  (`:34`) describe exactly the model this plan overturns; rewrite both. Add to
  the doc list.
- **`docs/design/windows.md`** — *retired*, not amended (the whole "two windows"
  doc + the "duplicate tokens in both CSS files" constraint dies with the
  dashboard).
- **The token-duplication rule** lives in **five** docs (`.design-context.md`,
  `tokens.md`, `failure-modes.md`, `change-checklists.md`, `color.md`) — all
  need the dashboard mirror removed. **`color.md:72-78`** ("status colors are
  dashboard-only, not in `tokens.css`") is now factually false.
- **The `shell/src/tokens.css` → `shell/src/ui/styles/tokens.css` path** is wrong
  in ~10 design docs + ADR-0008 (and, per the audit, **not** in `CLAUDE.md` — the
  earlier §7 note was itself wrong). Repo-wide correction.
- **`docs/commands.md`** (the `/ui/dashboard/` dev-open instruction 404s; `app:ui`
  no longer builds a dashboard), **`docs/dev/testing-strategy.md`** (its "no cargo
  test / no UI assertions" facts change under §10), **`docs/dev/i18n.md`** (dashboard
  key group + window-title keys), **beta-channel doc** (discovered-port) — all
  join the docs-to-update list.

### 11.5 Design rules to close explicitly

Master-detail rows must be **list-rows/typographic sections, not cards**
(card-nesting ban); the splash needs the **i18n runtime added** (none today) +
the `{fileManager}` noun; `native-quit-body` copy is stale; resolve the
**dual-"Diagnostics"** naming (§8). All other binding design rules (five
principles, one-Fraunces, `:focus-visible`, reduced-motion, `Cmd-K` reserved,
active-nav surface-step) were audited as **conforming**.
