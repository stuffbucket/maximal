# Maximal on Linux

Maximal runs on **Debian 13 (trixie)**, **Ubuntu 24.04 LTS** and **Ubuntu
26.04 LTS**, on 64-bit Intel/AMD (amd64) and ARM (arm64) machines. You install
and update it with apt, from Maximal's own signed package repository.

There are two packages:

| Package | What you get | For |
|---|---|---|
| `maximal-desktop` | The tray app, plus everything in `maximal` | A desktop (KDE, GNOME, …) |
| `maximal` | The `maximal` command and the proxy, with no window | A server, a VM, or a terminal-only setup |

## Install

Copy this whole block into a terminal. It is the same on all three systems.

```sh
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://mxml.sh/apt/maximal.asc | sudo tee /etc/apt/keyrings/maximal.asc >/dev/null
sudo tee /etc/apt/sources.list.d/maximal.sources >/dev/null <<'EOF'
Types: deb
URIs: https://mxml.sh/apt
Suites: stable
Components: main
Signed-By: /etc/apt/keyrings/maximal.asc
EOF
sudo apt update
sudo apt install maximal-desktop   # desktop: tray app + proxy
# or: sudo apt install maximal     # headless: proxy only
```

The first lines add Maximal's signing key and repository; apt then checks
every package against that key.

### On a desktop

Open **Maximal** from your app menu. It sits in the system tray and starts the
proxy for you. Settings and the Dashboard open from the tray icon, from the app
menu entry, or in a browser at <http://127.0.0.1:4141/ui/settings/> and
<http://127.0.0.1:4141/ui/dashboard/>.

- **KDE Plasma** shows the tray icon out of the box.
- **GNOME** needs the AppIndicator extension to show tray icons. Ubuntu
  includes it ("Ubuntu AppIndicators"). On Debian, install it, then log out and
  back in:

  ```sh
  sudo apt install gnome-shell-extension-appindicator
  gnome-extensions enable appindicatorsupport@rgcjonas.gmail.com
  ```

  Without it Maximal still runs; use the app menu entry or the browser to reach
  Settings.

### Headless (no desktop)

Sign in once, then run the proxy as a service of your user account:

```sh
maximal auth                               # sign in to GitHub (device code)
systemctl --user enable --now maximal      # start now and at every login
sudo loginctl enable-linger "$USER"        # keep it running without a login session
```

Check on it with `systemctl --user status maximal` and read its log with
`journalctl --user -u maximal -f`. Settings are at
<http://127.0.0.1:4141/ui/settings/> from the same machine (over an SSH tunnel
from elsewhere: `ssh -L 4141:127.0.0.1:4141 <host>`).

The service listens on 127.0.0.1 only. To change how it starts (another port,
`--account-type enterprise`, or `HOST` for other machines, with an API key
required), add an override:

```sh
systemctl --user edit maximal
```

```ini
[Service]
ExecStart=
ExecStart=/usr/bin/maximal start --account-type enterprise
```

## Update

Maximal checks for new versions on its own. When one is out:

- the tray app's menu item and the button at the top of Settings read
  **Update with apt**. They show the command below with a Copy button; Maximal
  never runs apt or asks for your password itself;
- `maximal start` logs a line such as
  `Maximal 0.6.0 is available: sudo apt update && sudo apt install --only-upgrade maximal`.

To update:

```sh
sudo apt update && sudo apt install --only-upgrade maximal maximal-desktop
```

(Leave out `maximal-desktop` if you only installed `maximal`. A plain
`sudo apt upgrade` updates them too.)

Then restart what was running: quit Maximal from the tray and open it again,
or run `systemctl --user restart maximal` for the service.

### Release candidates

To try versions before they are released, change `Suites: stable` to
`Suites: rc` in `/etc/apt/sources.list.d/maximal.sources`, then update as
above. To go back, set it to `stable` again; apt keeps the release candidate
until a newer stable version is out.

## Uninstall

```sh
maximal uninstall --force                   # turn off Maximal in your AI apps
systemctl --user disable --now maximal      # if you ran the service
sudo apt remove maximal-desktop maximal
```

Your settings, sign-in and logs stay in `~/.local/share/maximal` (or
`$COPILOT_API_HOME`). Delete that folder to remove them. To remove the
repository too:

```sh
sudo rm /etc/apt/sources.list.d/maximal.sources /etc/apt/keyrings/maximal.asc
```

## For developers

**Signing key.** The repository is signed with an Ed25519 key, fingerprint
`7317 FD60 4A59 1AFF C923  5436 C827 0651 B026 DDF6`. Check a downloaded key
with `gpg --show-keys /etc/apt/keyrings/maximal.asc`. apt 2.4 and newer read
the armored key directly from `Signed-By`.

**What the packages install.**

| Path | Package |
|---|---|
| `/usr/bin/maximal`, `/usr/bin/maximal-mcp-broker` | `maximal` |
| `/usr/lib/systemd/user/maximal.service` (not enabled) | `maximal` |
| `/usr/lib/maximal/installed-by-apt` | `maximal` |
| `/usr/bin/maximal-desktop`, its `.desktop` entry and icons | `maximal-desktop` |
| `/usr/lib/maximal/desktop-installed-by-apt` | `maximal-desktop` |

Nothing goes under `/etc`. `maximal-desktop` depends on exactly its own
version of `maximal` and runs `/usr/bin/maximal` as its proxy (the binary next
to its own), so the two always upgrade together. The marker files tell
`maximal` it was installed by apt, so it offers the apt command instead of the
download page; the desktop marker adds `maximal-desktop` to that command.

**Versions.** A release `0.6.0-rc.1` is the Debian version `0.6.0~rc.1`, so it
sorts before `0.6.0`. The `stable` suite carries the release the stable update
channel names, and `rc` the one the `rc` channel names; both are rebuilt with
mxml.sh, so apt can always install the version the apps announce.

**Other ways to run it.** The release page also has the raw binaries
(`maximal-vX.Y.Z-linux-x64.tar.gz`, `-linux-arm64.tar.gz`). To build from
source, see [commands](commands.md) and the source build in
[Work IQ on Linux](linux-workiq.md#build-from-source).

**How it's built.** `build/linux/` holds the packaging, the container smoke
test and the apt repository scripts; the release and Pages workflows are
described in the [release runbook](release-runbook.md).
