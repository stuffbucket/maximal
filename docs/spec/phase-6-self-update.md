# Phase 6 — Self-update

## 30-second context

Add `maximal upgrade` that's aware of the install source. Brew/MSI users
get a hint to use their package manager; bare-tarball and .app users get a
download-and-replace flow. Mirrors `gh CLI` and `mise` behavior. Lower
urgency than Phases 1-5; ship when other phases land.

## Goals

1. `maximal upgrade` works correctly regardless of how the user installed.
2. No accidental clobbering of brew/MSI-managed binaries by a self-update
   path that doesn't know it's running under a package manager.
3. Versions, source URLs, and SHAs come from the same release artifacts the
   release pipeline already publishes — no new infrastructure.

## Non-goals

- Auto-update on a schedule. Push, don't poll. User opts in by running
  `maximal upgrade`.
- A daemon that downloads in the background. The proxy stays focused on
  proxying.
- Channel selection (stable / beta / nightly). One channel — `latest`.
  Channels are a possible follow-up.

## Design

### 6.1 Install-source detection

Reads `${COPILOT_API_HOME}/state/installed-by` (Phase 5). Possible values:
`homebrew`, `msi`, `app-bundle`, `tarball`, `unknown`.

If absent (pre-Phase-5 install), heuristic:

```ts
function detectSource(): InstalledBy {
  if (await exists("/opt/homebrew/Cellar/maximal")) return "homebrew"
  if (await exists("/usr/local/Cellar/maximal"))    return "homebrew"
  if (await registryKeyExists("Software\\stuffbucket\\maximal")) return "msi"
  if (await exists("/Applications/maximal.app"))    return "app-bundle"
  if (await onPath("maximal") && (await execPath()).includes(".local/bin")) return "tarball"
  return "unknown"
}
```

Write the result to the marker file once detected so subsequent runs are
fast and unambiguous.

### 6.2 Upgrade strategies by source

| Source | Strategy |
|---|---|
| `homebrew` | Print: `Run "brew upgrade maximal"`. Exit 0. |
| `msi` | Print: `Download the latest MSI from https://github.com/stuffbucket/maximal/releases/latest`. Exit 0. |
| `app-bundle` | Download the latest `.app.zip`, verify SHA, replace `/Applications/maximal.app` atomically (write to `.app.new`, rename, restart launchd agent). |
| `tarball` | Download the latest `.tar.gz`, verify SHA, swap `~/.local/bin/maximal` via spawn-updater-exit (Windows) or atomic rename (macOS/Linux). |
| `unknown` | Print: `Can't determine install source. Reinstall from https://...`. |

### 6.3 Atomic swap for app-bundle / tarball

macOS / Linux: write new file alongside, `rename(2)` it over the old one.
Atomic. Process re-execs.

Windows: can't replace a running `.exe`. Pattern from `gh CLI`:

1. Write new binary to `${INSTALL_DIR}\maximal.exe.new`.
2. Spawn a tiny PowerShell helper that waits for the parent to exit, then
   does `Move-Item -Force maximal.exe.new maximal.exe`, then re-launches
   `maximal start`.
3. Parent process exits.

Tiny enough that we can ship the helper inline rather than as a separate
binary.

### 6.4 SHA verification

Always. Pull the `.sha256` sidecar from the release, compare. Refuse to
swap on mismatch.

### 6.5 Release URL resolution

Fixed canonical:

```
https://github.com/stuffbucket/maximal/releases/latest/download/maximal-v<VERSION>-<arch>.<ext>
```

Where `<VERSION>` is resolved by hitting
`https://api.github.com/repos/stuffbucket/maximal/releases/latest` and
reading `tag_name`. No PAT required; this endpoint is anon-readable.

### 6.6 `--prerelease` flag

Future-friendly stub. Today: ignored, prints a warning that prereleases
aren't a separate channel. When channels exist, this flag becomes real.

## Acceptance

- `maximal upgrade` on a Homebrew install prints the brew hint, doesn't
  download anything, doesn't touch `/opt/homebrew/Cellar/maximal`.
- `maximal upgrade` on a tarball install (Linux or macOS) downloads the
  newer release, verifies the SHA, atomically swaps the binary, restarts
  the launchd agent, and reports the new version.
- `maximal upgrade` on a Windows MSI install prints the MSI hint; doesn't
  attempt a download.
- `maximal upgrade` on a Windows tarball install (rare; primarily for CI
  cases) does the spawn-updater-exit dance.
- `maximal upgrade --check` prints "available: vX.Y.Z" and exits without
  doing anything.

## Estimate

3 days. Atomic-swap + spawn-updater-exit is the main work; install-source
detection is mechanical once Phase 5 is in.

## Open questions

1. Should we add a once-per-day silent "newer version available" hint that
   appears in `maximal start`'s startup banner? Easy to add; controlled by a
   config knob `checkUpdates: false` for users who hate it.
2. Channels — when (not if) we add `beta` and `nightly`, do they share
   `tag_name` semantics or use a separate API? Defer until first beta is
   actually cut.
3. Should the `app-bundle` upgrade path also re-run `first-launch` (which
   re-registers the launchd plist)? Yes — keeps plist in sync if the
   template changed between versions.
