# Windows test VM via UTM

Goal: a fast iteration loop for Windows-side installer / scheduled-task
work without needing a physical Windows machine. UTM (QEMU) on Apple
Silicon runs Windows 11 ARM acceptably for this workload, and the existing
"Windows" VM in the host's UTM library is the starting point.

## Constraints (UTM 4.7.4 specifics)

- **No AppleScript snapshot/revert.** The dictionary exposes `start`,
  `suspend [saving:true]`, `stop`, `export`. Neither `snapshot` nor
  `restore`.
- **Sandbox blocks raw `qemu-img`.** UTM stores `.utm` bundles inside its
  app sandbox; `qemu-img snapshot` from the shell can't reach them.
- **In-VM snapshots from the GUI** exist (Settings → drive properties),
  but they're per-disk and harder to script.

The viable workflow is therefore **export-as-baseline + reimport on
revert**. UTM's `export` command writes a complete `.utm` clone to any
location on disk; reverting is "delete the dirty VM, double-click the
baseline copy to import."

## Helper

`scripts/dev/utm.sh` wraps the AppleScript surface:

```sh
./scripts/dev/utm.sh ls                  # inventory
./scripts/dev/utm.sh status              # status of the Windows VM
./scripts/dev/utm.sh start               # start the Windows VM
./scripts/dev/utm.sh suspend             # pause + persist state
./scripts/dev/utm.sh stop                # power off
./scripts/dev/utm.sh baseline            # export to ~/UTM-Baselines/
./scripts/dev/utm.sh restore             # re-import the latest baseline
```

All commands accept an optional VM name as the second arg
(default: `Windows`).

## Bring-up checklist (one-time)

The `Windows` VM bundle currently has a 15 GB disk — likely a stalled
install. Two paths:

### Option A: finish the existing install

1. UTM → start `Windows`. Resume Windows Setup if it's mid-install,
   or boot the attached Windows 11 ARM ISO if not.
2. Resize the disk first. UTM Settings → Drives → the 15 GB IDE drive
   → bump to 64 GB minimum (Windows 11 minimum is 64 GB; recommend
   80 GB to leave room for Bun + WiX + Claude Desktop).
3. Inside Windows after install: enable Developer Mode, install:
   - PowerShell 7 (`winget install Microsoft.PowerShell`)
   - WiX 5 toolset (`dotnet tool install --global wix`)
   - Bun (`powershell -c "irm bun.sh/install.ps1 | iex"`)
   - Claude Desktop (download from claude.ai/download)
   - Optional: Windows Terminal, VS Code Remote-SSH back to the Mac

### Option B: start fresh

1. UTM → File → New → Virtualize → Windows. Pick the bundled
   `26100.4349…CLIENTCONSUMER…ARM64FRE…iso` already on disk.
2. Set RAM ≥ 8 GB, CPU ≥ 4 cores, disk 80 GB minimum.
3. Install Windows 11 ARM. Skip the Microsoft account prompt by
   pressing **Shift+F10** at the OOBE → `OOBE\BYPASSNRO` → reboot →
   choose "I don't have internet."
4. Install the same toolset as Option A.

### Take the first baseline

Once the VM is configured the way you want it for testing:

```sh
./scripts/dev/utm.sh stop          # baseline must be a clean shutdown
./scripts/dev/utm.sh baseline      # exports to ~/UTM-Baselines/Windows-<ts>.utm
                                   # also symlinks Windows-latest.utm
```

The symlink lets the helper find the most recent baseline without
hardcoding a timestamp.

## Iteration loop

```
# 1. Cross-compile the Windows binary on the Mac.
bun build --compile --target=bun-windows-x64 src/main.ts \
  --outfile dist-bin/maximal.exe

# 2. Drop maximal.exe + the WiX .wxs into the VM's shared folder.
#    UTM Settings → Sharing → "Shared Directory" → ~/maximal-share
cp dist-bin/maximal.exe ~/maximal-share/
cp build/windows/maximal.wxs ~/maximal-share/

# 3. In the VM (PowerShell):
cd \\TSCLIENT\maximal-share        # or wherever UTM mounts it
wix build maximal.wxs -d Version=0.0.0-dev -arch x64 -o maximal-test.msi
.\maximal-test.msi /qn             # silent install
maximal debug                       # smoke check
maximal uninstall

# 4. Tear it back down.
./scripts/dev/utm.sh suspend       # snapshot RAM+disk for fast resume
# OR
./scripts/dev/utm.sh stop          # full power-off
./scripts/dev/utm.sh restore       # if test corrupted state, reimport baseline
```

The cross-compile-on-Mac trick is the key win: build cycle drops from
"compile in VM" (~30 s) to "compile on Mac" (~5 s) plus instant exec
inside the VM via the shared folder.

## When to take a fresh baseline

Refresh `~/UTM-Baselines/Windows-latest.utm` after:

- Any system update (`winget upgrade --all`)
- Toolchain bumps (Bun, WiX, dotnet, Claude Desktop)
- A successful install/uninstall round-trip with the latest installer
  shape (so the baseline includes any required OS prerequisites)

```sh
./scripts/dev/utm.sh stop
./scripts/dev/utm.sh baseline
```

The bundle is a directory; export takes ~30 s to a few minutes
depending on disk size.

## Reverting after a bad install

```sh
./scripts/dev/utm.sh stop
./scripts/dev/utm.sh restore
# UTM opens the baseline file; choose "Add" when prompted.
# Delete the dirty Windows VM in UTM's sidebar.
# Optionally rename the imported one back to "Windows".
```

If you want a hands-off revert, accept that "delete + reimport" is two
clicks in UTM's UI. There's no public API to script those clicks in
4.7.x.

## Known limitations

- **No native Windows runner in CI for free.** GitHub Actions
  `windows-latest` is a separate path used by `release.yml` /
  `installers.yml`; this VM is for local iteration, not CI replacement.
- **ARM64 emulation of x64 binaries is fast but not native.** Our Bun
  output is x64 (per the matrix in `release.yml`); it runs on Windows 11
  ARM via Microsoft's x64 emulation layer, which is fine for installer
  validation but a poor target for performance regression testing.
- **Shared-folder paths are case-insensitive and have a UNC prefix
  (`\\TSCLIENT\…`).** Some installer code that hard-codes drive letters
  may need adjustment; we don't currently.
- **VM RAM is not shared with the host.** Don't run heavy workloads
  on macOS while iterating; the VM will swap.

## When UTM isn't enough

For full corp-IT-image fidelity (group policy, MDM, Defender ATP), use
**Azure Dev Box** instead. The UTM workflow above covers most of what
maximal needs to validate on Windows; the rare cases where it doesn't
should be flagged in PR descriptions and tested on a Dev Box before
merge.
