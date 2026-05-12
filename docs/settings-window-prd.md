# PRD: Settings Window

## Problem

The "Settings" tray-menu item currently opens `~/.local/share/maximal/` in Finder. That's an MVP — a user who knows what they're doing can drop into `config.json` with a text editor and the docs. For everyone else, it's:

- "What field do I edit?" (the zod schema has ~12 top-level fields plus per-provider configs)
- "Is this typo'd? Where do invalid keys go?" (zod warns but `.loose()` keeps them)
- "Why is my Anthropic key being ignored?" (env-vs-file-vs-config precedence is invisible)
- "Did my change take effect?" (no feedback; restart-required behaviors are silent)

We need a real Settings UI that exposes the same surface the file edit does, validates inline, shows precedence honestly, and tells the user when a change requires restart.

## Goals

- Replace the Finder hand-off with a proper Tauri window driven by the proxy.
- Cover every field the proxy currently respects from `config.json` and `secrets/*`.
- Make precedence visible (env wins; file fills in; config is the lowest-priority source for the few fields that can live there).
- Validate on save; never persist a `config.json` that doesn't round-trip through zod.
- Hot-reload what the proxy can hot-reload. Banner-and-button restart for the rest.

## Non-Goals

- Editing GitHub auth in Settings. That belongs in the first-run flow (separate PRD); Settings shows status + a "Sign out" affordance.
- Multi-user / team profiles. Single local user only.
- Web-hosted Settings. Local only; works offline.
- Migrating away from `config.json` as the source of truth. The window is a view; the file remains canonical.

## Surface

A Tauri webview window pointed at `http://localhost:4142/settings`. The page is a static Vite-built TS bundle from `shell/src/settings/` served by the proxy alongside `/usage-viewer`. Same pattern, same unauthenticated route, same dev story.

The tray menu's "Settings" item now opens this window (replaces the current `opener::open_path(~/.local/share/maximal)`).

Window: `~880×720`, resizable, single window (re-show + focus if already open).

## Layout

Left rail: navigation. Right pane: section content.

```
┌─────────────────────────────────────────────────────────────┐
│ maximal — Settings                                          │
├──────────────┬──────────────────────────────────────────────┤
│ Account      │  <selected section here>                     │
│ API clients  │                                              │
│ Providers    │                                              │
│ Secrets      │                                              │
│ Routing      │                                              │
│ Per-model    │                                              │
│ Advanced     │                                              │
│ Diagnostics  │                                              │
└──────────────┴──────────────────────────────────────────────┘
```

Persistent footer (left-to-right):

- **"Reveal config in Finder"** — opens the app data dir (`~/.local/share/maximal/`), preserving the current MVP affordance for power users.
- **"Reveal logs in Finder"** — opens `~/.local/share/maximal/logs/` directly. Daily log files (`messages-handler-<date>.log`) are the first stop when debugging routing decisions and SSE translation. Surfacing the dir from the window saves a second `cd` for non-CLI users.
- **"Restart proxy"** — greyed unless a restart-required change is staged.

Both Finder affordances are Tauri commands (`reveal_config_dir`, `reveal_logs_dir`) invoked from JS — they don't navigate the webview, they call into Rust which calls `opener::open_path()` on the target directory.

### Section: Account

Read-only, with one action.

- **GitHub Copilot** — shows token presence (✓/✗), masked token tail (last 4 chars), token last-validated timestamp.
- **Sign out** button — deletes `github_token`, returns the proxy to "needs setup" state. Confirmation dialog: "This will sign you out. The proxy will stop serving Copilot requests until you sign in again."

No edit of token contents — that's a one-way flow via the device-code OAuth in the setup window.

### Section: API clients

The `auth.apiKeys: string[]` field. Keys clients use to authenticate against *this* proxy (the `Authorization: Bearer` / `x-api-key` middleware).

- Table: each key as a row. Columns: created-at (if we track it; otherwise just an index), masked key (last 4), Copy, Revoke.
- "Generate new key" button → server generates a 32-byte hex token, appends to `auth.apiKeys`, returns the plaintext once (with a copy-to-clipboard nudge: "This is the only time we'll show this in full.")
- Optionally: label per key (would require schema change; out of v1).

Empty state: "No API keys yet. The proxy accepts all local requests when this list is empty." (matches current behavior; flagged as a security note.)

### Section: Providers

The `providers: Record<string, ProviderConfig>` map. Each entry is one card.

Per provider card:
- Name (record key, e.g. `anthropic`)
- Enabled toggle (`enabled`)
- Base URL (`baseUrl`)
- API key — show status (env/file/config/unset, masked tail). Click "Edit" routes into the Secrets section, scoped to that provider.
- Type (`type`)
- Default temperature / topP / topK
- Models sub-table: per-model overrides (temperature, topP, topK, adjustInputTokens). Expandable.
- Delete provider (confirmation: "Remove provider 'X' from routing? Existing requests already in flight finish; new requests for its models will fall back to Copilot.")

"+ Add provider" at the bottom: name + type + baseUrl form. Validates the name (`/^[a-z][a-z0-9_-]*$/`) and prevents collisions.

### Section: Secrets

The `SECRET_DEFS` catalog: currently `anthropic_api_key`, `ollama_api_key`. One row per secret.

Columns: name (human), source (env / file / config / unset), value tail (last 4 chars, only if file or config — never echo env values), Edit, Clear.

- **Edit** opens a single-field dialog: textarea + "Save to file (mode 0600)" button. Writes via `PATCH /secrets/<name>`. Tooltip: "Env vars take precedence over saved values."
- **Clear** removes the file. If env is set, the source flips to "env" with a tooltip explaining; if not, "unset."
- **Source indicator** is the key UX win — explains why "I set my key but it's not working" (env var hiding the file, or vice versa).

### Label convention (applies to every control below)

Each control has a **human-first label** (what the user sees), an optional **one-line description** below it, and a **tooltip** on a `(?)` chip that includes the underlying `config.json` field name. The field name is *only* in the tooltip — visible to power users translating from docs or hand-edited config, invisible to everyone else.

This honors design principle #1 ("Speak to the person, not the file") while preserving the escape hatch for users who already know what `useMessagesApi` does.

### Section: Routing

Hot-reloadable settings that change how the proxy routes requests upstream. Save → inline checkmark fades in beside the control → values propagate live (no restart).

| Label | Type | Description | Field name (tooltip) |
|---|---|---|---|
| Use Claude's native messages format | toggle | Routes Claude models through Copilot's `/v1/messages` endpoint instead of falling back to Chat Completions. Better streaming and tool-call fidelity. | `useMessagesApi` |
| Accept the `apply_patch` tool | toggle | Lets clients (like Claude Code) send the `apply_patch` tool shape for surgical file edits. | `useFunctionApplyPatch` |
| Use Responses API for web search | toggle | Routes models that support live web search through Copilot's `/responses` endpoint, where the search tool is wired up. | `useResponsesApiWebSearch` |
| Small model for warmups | model picker | The model the proxy uses for tool-less probe/warmup requests. Lighter than your main model — saves your quota. | `smallModel` |
| Claude token estimate multiplier | number (default 1.15) | Inflates GPT-tokenizer counts by this factor when estimating Claude token usage. Set to 1.0 if you're paired with an Anthropic API key that gives exact counts. | `claudeTokenMultiplier` |
| Keep logs for | number, suffix "days" (0–3650, default 7) | How long the daily proxy logs stick around before rotation. | `logRetentionDays` |

### Section: Per-model

Per-model overrides, presented as three tables. Each table's first column is a model picker with autocomplete from the live `/models` list; subsequent columns are the override.

| Table label | What it controls | Field name (tooltip) |
|---|---|---|
| Extra system prompt per model | Text appended to the system prompt for a specific model. Useful for nudging tool use or output format on one model without affecting others. | `extraPrompts` |
| Reasoning effort per model | Sets the effort hint Copilot passes upstream. Options: minimal / low / medium / high. | `modelReasoningEfforts` |
| Server-side context management | Models that opt into Copilot's `/responses` context management instead of carrying full history on every request. | `responsesApiContextManagementModels` |

If a per-model table is empty, the section shows the empty-state CTA "Add a model override" — not a blank list with a `+` button. (Design principle #2 — power lives in depth.)

### Section: Advanced

Default-collapsed. Heading sub-copy: "These settings rarely need changing. Open if you know what you're doing."

| Label | What it does | Field name (tooltip) |
|---|---|---|
| Anthropic API key (for token counting) | Used only by `/v1/messages/count_tokens` to get exact Claude token counts. Aliased to the `anthropic` secret — env var takes precedence. | `anthropicApiKey` |
| Reveal `config.json` in editor | Opens the raw config in your default editor for hand-editing. Last resort; everything above should make this unnecessary. | (action, not a field) |
| Reset settings to defaults | Writes `{}` to `config.json` after backing up the current file to `config.json.bak-<timestamp>`. Confirmation dialog states the consequences explicitly: "This won't sign you out or touch your API keys." | (action, not a field) |

### Section: Diagnostics

Live data, not editable:

- Proxy version (`BUILD_VERSION`), git SHA (`BUILD_GIT_SHA`), git branch (`BUILD_GIT_BRANCH`)
- Sidecar process PID (from `/_debug/state` if available)
- Effective `evaluateSetup()` (the same data the first-run PRD's `/setup-status` returns)
- Token rate-limit budget (existing `state.rateLimit` data)
- "Open logs folder" button (the affordance removed from the tray menu)
- "Copy debug bundle" button — concatenates: redacted config, secret sources (no values), `/_debug/state` snapshot, last 100 lines of today's daily log. Goes to clipboard.

## Backend changes

### New routes (all unauthenticated, gated to localhost-only via existing auth middleware skip-list)

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/settings` | — | the static Vite bundle (HTML/JS/CSS) |
| `GET` | `/config` | — | redacted current `AppConfig` (secrets stripped) |
| `PATCH` | `/config` | partial `AppConfig` | the new full `AppConfig` after merge + zod validation |
| `POST` | `/auth/api-keys` | — | `{ key: string }` (plaintext; only response showing it) |
| `DELETE` | `/auth/api-keys/:tail` | — | new `auth.apiKeys` list |
| `GET` | `/secrets` | — | `[{name, source, tail?}]` for every entry in `SECRET_DEFS` |
| `PATCH` | `/secrets/:name` | `{ value: string }` | new metadata for that secret |
| `DELETE` | `/secrets/:name` | — | new metadata for that secret |
| `POST` | `/proxy/restart` | — | 202; sidecar restart routed via Tauri (proxy itself can't restart itself, so this just returns a "restart pending" signal the shell consumes) |

### Hot-reload boundary

`src/lib/state.ts` already holds mutable singletons. Config save:

1. Validate via zod.
2. Atomic write to `config.json` (write to `.tmp`, rename).
3. Call existing `loadConfigFromDisk()` to refresh in-memory state.
4. Compare before/after; any field in the *restart-required* set returns `{ restartRequired: true }` in the response.

Restart-required set (initial): `auth.apiKeys` removal (existing tokens in flight stay valid; new requests get rejected on next handshake), `providers[*].baseUrl` (live connections drain; not catastrophic but worth surfacing).

Restart-not-required: everything else. Flag toggles, prompts, multipliers all read from state on each request.

### Secrets save

- `PATCH /secrets/:name` → writes to `~/.local/share/maximal/secrets/<fileName>` with `fs.writeFile(..., { mode: 0o600 })`.
- Source resolution recomputed live (env still wins).
- No restart needed; the existing `loadSecretIntoEnv()` is per-request.

## Shell changes

- Tray menu "Settings" handler: `app.create_window("settings", "http://localhost:4142/settings")` instead of `opener::open_path(...)`.
- Settings window state: single-instance, reuse + focus pattern matching the existing dashboard.
- Listen for `proxy/restart` request from the webview (Tauri command invoke). When received: SIGTERM the sidecar via the existing `kill_sidecar`, then re-spawn. Same path the Quit menu uses for kill — extended with a respawn.

## Validation

- Client-side zod parse on every form field (the same schema used server-side, imported through a shared `src/lib/config-schema.ts` bundle that ships to the frontend).
- Save is enabled only when the section is dirty AND valid.
- Field-level errors render inline under the field; section-level errors at the top of the section.

## Failure Modes

- **Proxy unreachable while Settings is open.** Banner: "Proxy offline. Changes can't be saved." All fields go read-only. Polls `/_debug/state` (or `/setup-status`) every 5s and recovers on re-connect.
- **Save races (two writes overlapping).** Server uses a file mutex for `config.json` writes; PATCH carries an `If-Match` ETag computed from the file's mtime + size. Mismatch → 409 + "config changed on disk — reload." User clicks Reload, sees the new state, retries.
- **Schema drift** (config.json contains a key the running proxy doesn't know about — `.loose()` allows this). Settings surfaces unknown keys in a "Foreign config keys" advisory in Diagnostics. Doesn't silently drop them.

## Telemetry / Observability

- `/_debug/state` gains a `settings` block: last-saved-at timestamp, last-saved-by ("web" | "cli" | "unknown"), the restart-required pending state.
- Each save logged at info-level: `"settings.saved keys=[...] restartRequired=<bool>"`. No values logged.

## Migration

- Existing `config.json` keeps working. Settings reads, validates, presents.
- Users who hand-edit while the window is open get the 409 + reload path.
- Users on the current MVP (Finder hand-off) get the new window on next launch.

## Open Questions

1. **Window vs. modal vs. menu-bar-extra popover.** Settings as a full window is conventional; a popover (NSPopover-style) keeps the "menu-bar app" feel but is too small for the provider sub-tables. Lean **window**.
2. **Should we ship API key labels in v1?** It's a 5-line schema change (`apiKeys: Array<{ key: string, label?: string, createdAt: string }>`). Adds value but ties this PRD to a schema migration. Lean **no** for v1; bare strings stay; revisit if real usage demands it.
3. **Per-model autocomplete data source.** Live `/models` list works but only after auth. Use the cached list from state if the live fetch fails. Confirm acceptable.
4. **Should "Reset to defaults" wipe `secrets/` too?** Lean **no**; secrets are user data, not config. Separate "Clear secret" per row already covers it.
5. **Dark mode.** Match `prefers-color-scheme`. Cheap; do it.
6. **Future: provider OAuth flows for non-GitHub providers.** Out of v1, but design the Secrets section so adding a "Sign in" button per provider in v2 is a one-control addition.

## Acceptance

Fresh `.app` install on a Mac with an existing CLI install (so account + config are populated):

1. User clicks the tray icon → Settings.
2. Settings window opens within ~500ms, populated with their current config.
3. User switches "Accept the `apply_patch` tool" to on, hits Save. Inline checkmark beside the toggle fades in for ~2s. The next request the proxy serves reflects the new flag (no restart).
4. User generates a new API key. Plaintext appears in a copy-once dialog. Closing the dialog re-renders the key as masked tail.
5. User edits the Anthropic provider's `baseUrl`. Save banner: "Restart proxy to apply." Clicks Restart. Sidecar dies and respawns within ~3s; Settings window reconnects and clears the banner.
6. User hovers the `(?)` chip beside "Accept the `apply_patch` tool"; tooltip reveals `useFunctionApplyPatch` so they can grep the proxy source if needed.
7. User opens Diagnostics, clicks "Copy debug bundle." Clipboard now contains a redacted dump suitable for pasting into a bug report.
8. User closes the window. Reopening shows the same persistent state (no draft state survives, by design — explicit save model).

Throughout: zero terminal use, zero raw JSON editing, every change observable with one click. **A user who has never seen `config.json` should be able to operate every setting in this window correctly.**
