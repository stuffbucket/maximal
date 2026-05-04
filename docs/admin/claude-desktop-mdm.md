# Claude Desktop / Cowork MDM reference

What managed-preferences keys Claude Desktop reads, where they live,
and which ones matter for using this proxy as a third-party inference
gateway.

Last verified: 2026-05-04.

## Why this matters here

Claude Desktop's "Cowork on third-party inference" mode has two
configuration tiers:

1. **UI preferences** in `~/Library/Application Support/Claude/claude_desktop_config.json`
   — what you see in Settings panels.
2. **MDM / managed preferences** in the macOS user defaults domain
   `com.anthropic.claudefordesktop` (or Windows `HKCU\SOFTWARE\Policies\Claude`)
   — what an admin pushes via Jamf / Kandji / Intune in production.

Several behaviors that look like "broken developer mode" are really
"this knob has no useful default; admins are expected to populate it
via MDM." For solo developer use you can write the same keys directly
with `defaults write` (no MDM needed) and Claude Desktop respects them.

**Precedence (highest first):** server-managed > MDM/OS-level >
file-based managed-settings > Windows registry. The
`claude_desktop_config.json` UI preferences sit below the managed tier.

## Default profile written by `copilot-api setup`

The wizard now writes the full "Default" profile that Claude Desktop's
**Configure third-party inference** panel surfaces, not just the three
gateway-wiring keys. The complete set:

```json
{
  "inferenceProvider": "gateway",
  "inferenceGatewayBaseUrl": "http://127.0.0.1:4141",
  "inferenceGatewayApiKey": "anything",
  "inferenceGatewayAuthScheme": "bearer",
  "disableDeploymentModeChooser": true,
  "isClaudeCodeForDesktopEnabled": true,
  "coworkEgressAllowedHosts": ["*"],
  "allowedWorkspaceFolders": ["$HOME/Claude"],
  "isDesktopExtensionEnabled": true,
  "isDesktopExtensionDirectoryEnabled": true,
  "isDesktopExtensionSignatureRequired": false,
  "isLocalDevMcpEnabled": true,
  "disableAutoUpdates": false,
  "disableEssentialTelemetry": true,
  "disableNonessentialTelemetry": true,
  "disableNonessentialServices": false
}
```

`allowedWorkspaceFolders` is parameterized to the running user's
`$HOME` and the directory is created on disk if missing. The merge is
allowlist-only — keys outside this set are preserved verbatim, and
`copilot-api uninstall --revert-claude` removes exactly these keys.

### MDM-tier interaction

The wizard owns one egress knob: file-tier `coworkEgressAllowedHosts:
["*"]`. Because MDM-tier defaults take precedence over the file, the
wizard reads `defaults read com.anthropic.claudefordesktop
coworkEgressAllowedHosts` and **deletes the MDM key if present** — most
commonly populated by Claude Desktop's own installer — so the
file-tier `["*"]` becomes the effective value. Uninstall does not
re-create the MDM key; users who want it back run `defaults write`
manually or re-run `scripts/install-cowork-egress.sh` for the curated
list.

## Key reference (subset relevant to this proxy)

| Key | Type | Default | Controls |
|---|---|---|---|
| `inferenceProvider` | string | unset | `gateway` / `bedrock` / `vertex` / `foundry`. Set via UI when you pick "Gateway" in Configure third-party inference. |
| `inferenceGatewayBaseUrl` | string | unset | Gateway endpoint URL (e.g. `http://localhost:4141`). |
| `inferenceGatewayApiKey` | string | unset | Bearer credential. We accept literal `anything`. |
| `inferenceModels` | JSON array (as string) | unset | Allowlist of model IDs / aliases. Useful to hide variants if our `/v1/models` listing changes. |
| `coworkEgressAllowedHosts` | JSON array | unset (= deny most) | **The egress allowlist that gates Cowork's bundled tool-call traffic.** Accepts exact hostnames (`api.github.com`), single-level wildcards (`*.corp.com`), and the bare sentinel `*` for allow-all. Wildcards don't cover the apex — `*.corp.com` matches `docs.corp.com` but not `corp.com` itself. Scope is **tool calls only** — inference and MCP traffic have their own allowlists. IP literals and `localhost` always resolve regardless of this list. Surfaced in the desktop UI under **Configure third-party inference → Sandbox & workspace → Allowed egress hosts** (with an `* Allow all` button). |
| `coworkWebSearchEnabled` | bool | `true` | (UI-tier preference, not MDM.) Enables Cowork's bundled WebSearch connector. |
| `isLocalDevMcpEnabled` | bool | `true` | Allow user-added local stdio MCP servers via Developer settings. |
| `managedMcpServers` | JSON array | unset | Org-pushed remote MCP servers (HTTP/SSE) — e.g. GitHub MCP, Atlassian MCP. |
| `isDesktopExtensionEnabled` | bool | `true` | Allow installation of `.mcpb` desktop extensions. |
| `allowedWorkspaceFolders` | JSON array | unset | Which absolute paths Cowork can attach as workspace folders. |

## Where to write these on macOS

Three options, by descending durability:

```sh
# 1. User defaults (simplest; survives restarts)
defaults write com.anthropic.claudefordesktop <key> <value>
defaults read  com.anthropic.claudefordesktop                  # inspect

# 2. Managed plist (MDM-style, requires writing a configuration profile)
sudo profiles install -path /path/to/com.anthropic.claudefordesktop.mobileconfig

# 3. Per-deployment file (relevant for fleet management)
# /Library/Managed Preferences/com.anthropic.claudefordesktop.plist
```

Restart Claude Desktop after any change (`Cmd+Q`, then relaunch).

## Practical recipes for this proxy

### Allow Cowork's connectors to navigate to common trustworthy hosts

`coworkEgressAllowedHosts` is the knob that controls Cowork's bundled
WebSearch / fetch egress filter. Three useful shapes:

```sh
# Curated allowlist (what scripts/install-cowork-egress.sh writes —
# ~120 entries spanning code hosting, package registries, language
# docs, standards bodies, news outlets, search engines, AI labs,
# cloud provider docs, and testing domains).
bash scripts/install-cowork-egress.sh

# Allow-all (single sentinel — Cowork's matcher honors bare "*").
defaults write com.anthropic.claudefordesktop coworkEgressAllowedHosts -array "*"

# Remove the key entirely (defaults to "deny most" again).
defaults delete com.anthropic.claudefordesktop coworkEgressAllowedHosts
```

Empty (or unset) is **not** the same as `*` — it's an allowlist, so
"unset" denies most hosts. `*` is the only way to switch off host
gating without disabling the connector. Cowork's UI surfaces this as
the `* Allow all` button under **Configure third-party inference →
Sandbox & workspace → Allowed egress hosts**.

With our proxy doing the actual web fetching via `OllamaWebExecutor`
on the proxy side, the curated allowlist is optional — Cowork's
bundled connectors aren't on the proxy's path for `web_search` (the
model emits a server-tool block, our proxy intercepts, Ollama
executes). But for `web_fetch` and other URL-grabbing connectors that
run inside the desktop process, the allowlist still gates them.

### Hide variant model IDs from the picker

We already drop `-high`, `-xhigh`, `-1m` variants in our `/v1/models`
listing (`fix(models): drop variant ids from listing` —
`47a7439`). If you want belt-and-suspenders enforcement, also set:

```sh
defaults write com.anthropic.claudefordesktop inferenceModels \
  -string '["claude-opus-4-7-20260301","claude-opus-4-6-20260301","claude-haiku-4-5-20260301","claude-sonnet-4-6-20260301"]'
```

That restricts the picker to exactly the IDs you list, regardless of
what the gateway returns.

### Disable WebSearch connector (alternative to egress allowlist)

If you want the proxy to be the sole web-tools path (no Cowork-side
connectors competing), keep this off:

```sh
# (lives in claude_desktop_config.json, not the MDM domain)
# Already set to false earlier in this project.
cat ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

## What developer-mode users typically need to set

| Goal | Where | Value |
|---|---|---|
| Point at the local proxy | UI: Configure third-party inference | already done |
| Skip the login chooser | UI: same panel | already done |
| Cowork bundled connectors reach common trustworthy hosts | `coworkEgressAllowedHosts` | see `scripts/install-cowork-egress.sh` |
| Cowork bundled connectors reach **any** host (turn host gating off) | `coworkEgressAllowedHosts` | `["*"]` (bare `*` is the allow-all sentinel) |
| Avoid duplicate variant ids in picker | proxy-side, already shipped | n/a |
| Local stdio MCP servers visible | `isLocalDevMcpEnabled = true` | usually default |

## Sources

- [Enterprise configuration for Claude Desktop](https://support.claude.com/en/articles/12622667-enterprise-configuration)
- [Deploy Claude Desktop for macOS](https://support.claude.com/en/articles/12611117-deploy-claude-desktop-for-macos)
- [Install and configure Claude Cowork with third-party platforms](https://support.claude.com/en/articles/14680741-install-and-configure-claude-cowork-with-third-party-platforms)
- [Claude Cowork desktop architecture overview](https://support.claude.com/en/articles/14479288-claude-cowork-desktop-architecture-overview)
- [Claude Cowork Enterprise Administrator Guide](https://claude.com/resources/tutorials/claude-cowork-enterprise-administrator-guide)
- Third-party cheatsheet: [howtoharden.com — Anthropic Claude Hardening Guide](https://howtoharden.com/guides/anthropic-claude/)
