# Phase 5 — Distribution simplification

## 30-second context

Reduce four user-visible Windows install paths (MSI, install.ps1, .zip,
Homebrew-not-applicable) to one (MSI). Add a config-snapshot file so
`maximal uninstall --force` correctly restores the user's prior
state — including MDM-tier `coworkEgressAllowedHosts` values that
`configure-claude-desktop` clears.

## Goals

1. Single canonical Windows install path: MSI. Drop install.ps1.
2. Uninstall is reversible: prior state of any key we touched is restored,
   not just the keys we wrote.
3. Install-source detection so `maximal upgrade` (Phase 6) can speak
   correctly to brew/MSI/.app users.

## Non-goals

- Restoring the `npm install -g @stuffbucket/maximal` path. Maximal's users
  aren't Node-shop developers; brew + MSI cover the audience.
- A new install path. We're collapsing, not adding.

## Design

### 5.1 Drop `install.ps1`

Delete:
- `build/windows/install.ps1`
- `tests/windows-installer-template.test.ts`
- The `windows-installer` job in `.github/workflows/installers.yml`

Update:
- `pages/index.html` install landing — Windows users see "Download MSI" only.
- `docs/admin/claude-desktop-mdm.md` references.

The MSI already has Add/Remove Programs integration, Start Menu shortcut,
proper `taskkill` custom action for upgrades, and is what MS-internal
deployments expect (group-policy-deployable). install.ps1 was only ever
"second-best."

### 5.2 Config snapshot for `configure-claude-desktop`

New file: `${COPILOT_API_HOME}/state/claude-desktop.snapshot.json`.
Schema:

```jsonc
{
  "schemaVersion": 1,
  "capturedAt": "2026-05-08T00:00:00Z",
  "fileTier": {
    "path": "/Users/brian/Library/Application Support/Claude/claude_desktop_config.json",
    "priorKeys": {
      "inferenceProvider": "__UNSET__",
      "coworkEgressAllowedHosts": ["github.com", "*.github.com"],
      "...": "..."
    }
  },
  "mdmTier": {
    "domain": "com.anthropic.claudefordesktop",
    "priorKeys": {
      "coworkEgressAllowedHosts": ["github.com", "*.github.com"]
    }
  }
}
```

`configure-claude-desktop` writes this file *before* mutating any keys.
Apply behaviour unchanged: write our 16-key default profile, clear MDM
`coworkEgressAllowedHosts`.

`uninstall --force` reads the snapshot and:

1. For each key in `fileTier.priorKeys`: if `__UNSET__`, remove from JSON;
   else write back the prior value.
2. For each key in `mdmTier.priorKeys`: re-write to the defaults DB via
   `defaults write` (or delete if `__UNSET__`).
3. Delete the snapshot file.

If the snapshot is missing (older install pre-Phase-5), fall back to the
current strip-our-keys behaviour and emit a warning that MDM-tier values
weren't restored.

### 5.3 Install-source marker

`installer scripts` write `${COPILOT_API_HOME}/state/installed-by` containing
one of:

- `homebrew`
- `msi`
- `app-bundle`
- `tarball`
- `unknown`

Used by Phase 6's `maximal upgrade` to pick the right strategy and by
`maximal debug` to surface in diagnostics. Write happens at install time
(MSI custom action; brew formula's `service do` + `install` step;
`first-launch` shim for the .app; manual for tarball).

For migrations from pre-Phase-5 installs, `maximal start` performs a
heuristic detection on first run (`/opt/homebrew/Cellar/maximal/...`,
Add/Remove Programs registry, etc.) and writes the marker.

## Acceptance

- The install landing page lists exactly: "macOS — Homebrew or DMG",
  "Windows — MSI". `install.ps1` is not referenced.
- `configure-claude-desktop` followed by `uninstall --force` on a
  machine that previously had `coworkEgressAllowedHosts: ["github.com"]`
  in its MDM tier *restores* that array. Verified by `defaults read` after
  the round-trip.
- A fresh MSI install creates `installed-by=msi`. A `brew install` creates
  `installed-by=homebrew`.
- `maximal debug --json` includes `install.source: <marker>`.

## Estimate

One day. Mostly file renames, JSON serialization, and three install-time
write hooks.

## Open questions

1. Should the snapshot file include a timestamp-suffixed history (one
   snapshot per `configure-claude-desktop` run)? Probably not — one is
   enough for revert; history is cheap to add later if needed.
2. What if `configure-claude-desktop --revert` is invoked from a snapshot
   created by a *different* user? Scope the snapshot to current user's
   home; `${COPILOT_API_HOME}` already does that.
3. The MSI "drop install.ps1" decision — does anyone in the field already
   depend on `iex (irm install.ps1)` for unattended setup? Internal-MS
   audit before merging.
