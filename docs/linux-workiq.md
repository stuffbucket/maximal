# Work IQ on Linux

This guide covers the local `@microsoft/workiq` MCP server behind Maximal's
broker. Maximal discovers and supervises Work IQ; it does **not** distribute it
or own its Microsoft authentication. Signing in from Settings, logs, and admin
approval are covered in [Work IQ](workiq.md). Pi is optional and has a
[separate connection guide](pi-workiq.md).

The package version used to validate sign-in and tool discovery was Work IQ
**1.0.1**, with Maximal **0.4.47** plus the Linux catalog fix documented below.
These checks did not exercise workplace queries, mutations, other tenants, or
a fresh-machine installation.

## Prerequisites

Use your normal desktop account, not root. You need a running user D-Bus session
and an unlocked Secret Service keyring such as GNOME Keyring. Do not replace the
secure token cache with plaintext storage. Microsoft 365 Copilot licensing,
tenant consent, and Conditional Access requirements are independent of Maximal's
GitHub Copilot login.

Install Maximal with apt as described in [Maximal on Linux](linux.md):
`maximal-desktop` for the tray app, or `maximal` for the proxy alone (run as a
user service). Check it with `maximal --version` and `maximal mcp`, and complete
Maximal's GitHub setup at `http://127.0.0.1:4141/ui/settings/`.

**Do not upgrade over or restart a proxy that carries an active coding
session.** Plan upgrades (`sudo apt install --only-upgrade …`) and restarts for
a quiet moment.

### Build from source

On another distribution, or to test unreleased changes, build from a reviewed
checkout of this repository with its pinned Bun and package toolchains (see
[commands](commands.md)):

```sh
bun install --frozen-lockfile --ignore-scripts
(cd shell && bun install --frozen-lockfile --ignore-scripts)
bun run ensure:ui-embed
bun run build:ui
bun run build
# Review and trust the mise configs before running package-local commands.
mise -C packages/mcp-broker exec -- pnpm install --frozen-lockfile
mise -C packages/mcp-broker exec -- pnpm build
```

Run the built CLI from the repository root so it can find the broker binary,
choosing your actual GitHub account type:

```sh
HOST=127.0.0.1 NODE_ENV=production MAXIMAL_UI_DIST="$PWD/shell/dist/ui" \
  bun dist/main.js start --port 4141 --account-type enterprise
```

In the commands below, substitute `bun /absolute/path/to/maximal/dist/main.js`
for `maximal`. Stage and validate source upgrades separately and keep a
rollback installation.

## Install Work IQ

Use your existing package manager. Install the 1.x line: Maximal runs the
native executable inside the package, so it relies on that package's layout.
With mise:

```sh
mise use --global npm:@microsoft/workiq@1
```

Or, with an appropriately configured Node/npm installation:

```sh
npm install --global @microsoft/workiq@1
```

Or, with pnpm (after `pnpm setup`):

```sh
pnpm add --global @microsoft/workiq@1
```

These download from the registry your npm configuration names:
`NPM_CONFIG_REGISTRY`, or `@microsoft:registry=` / `registry=` in `~/.npmrc`
(a `@microsoft:` scope registry wins), else `registry.npmjs.org`. The install
hint in Settings and `maximal mcp` shows which host that is. If your network
blocks it, either configure npm's registry as usual or set
`mcpBroker.catalog.npmRegistry` in Maximal's `config.json` to an `http(s)` URL;
the hint then adds `--registry <url>` (npm, pnpm) or starts with
`NPM_CONFIG_REGISTRY=<url>` (mise).

`maximal mcp` detects the native executable inside any of these installations,
including npm's global folder of a Homebrew, nvm, fnm, asdf, Volta, or
mise-managed Node; it does not run npm, pnpm, an npm launcher, or a mise shim.
If the shell's `workiq` launcher reports
`No version is set for shim: node`, select a compatible Node default, or use the
native binary directly. For the mise installation above:

```sh
WORKIQ_ROOT="$(mise where npm:@microsoft/workiq@1)"
case "$(uname -m)" in
  x86_64) WORKIQ_ARCH=x64 ;;
  aarch64|arm64) WORKIQ_ARCH=arm64 ;;
  *) printf 'Unsupported Work IQ architecture\n' >&2; exit 1 ;;
esac
WORKIQ="$WORKIQ_ROOT/node_modules/@microsoft/workiq/bin/linux-$WORKIQ_ARCH/workiq"
"$WORKIQ" --version
```

## Sign in interactively

Run this yourself, choosing the intended Microsoft 365 work account and tenant:

```sh
"$WORKIQ" auth login
```

Look for a window titled **Microsoft Authentication**, including on other
workspaces. A terminal waiting for that window is not necessarily hung. Cancel
expired attempts before starting a new one; do not reuse an old dialog.

If login fails with `AADSTS50011` for redirect URI
`https://login.microsoftonline.com/common/oauth2/nativeclient` and application
`ba081686-5d24-4bc6-a0d6-d034ecffed87`, Work IQ 1.0.1 supports browser login instead
of the native identity broker:

```sh
"$WORKIQ" config set disableBrokeredAuth=true
"$WORKIQ" auth login
```

This uses Work IQ's browser-based localhost callback; it does not disable issuer
validation or tenant/device policies. Do not edit Microsoft's app registration.
If policy denies access, consult your administrator. To restore the default
login mode, run `"$WORKIQ" config unset disableBrokeredAuth`.

If prompted for an EULA, review [Microsoft's terms](https://github.com/microsoft/work-iq)
and, only if you agree, run `"$WORKIQ" accept-eula` yourself before retrying login.
Do not automate acceptance or request broad consent preemptively. Never share
sign-in codes, tokens, account stores, or workplace results in issues or commits.

## Add and enable the endpoint

```sh
maximal mcp workiq --add
maximal mcp workiq --enable
maximal mcp
```

New Work IQ endpoints on Linux inherit `HOME` and `DBUS_SESSION_BUS_ADDRESS`.
The session-bus address lets libsecret read the tokens saved by your desktop
login. The address is resolved from Maximal's environment, not saved in config.
Other desktop variables and provider credentials are not added to the allowlist.

The running Maximal process must itself have `DBUS_SESSION_BUS_ADDRESS`. The
tray app inherits it from your desktop session. For the packaged user service,
add it with `systemctl --user edit maximal`:

```ini
[Service]
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus
```

Apply service environment changes with `daemon-reload` and a planned restart
from outside any session depending on this proxy. Adding the variable to an
endpoint cannot repair an absent variable in an already-running parent process.
Do not pass the entire desktop environment or switch to a system/root service.

The Claude-client selection only controls automatic Claude Code/Desktop setup.
A message saying no Claude integration is on does not prevent other MCP clients
from connecting to `http://127.0.0.1:<port>/mcp/workiq` (default port 4141).
Keep the endpoint on loopback and use endpoint/main-port API keys when required;
loopback alone does not isolate other local OS users.

### Existing endpoints created before the Linux fix

The catalog template is used when adding an endpoint. Upgrading Maximal does not
rewrite a user's existing environment policy. If Work IQ fails with:

```text
Cannot autolaunch D-Bus without X11 $DISPLAY
```

Back up the active `config.json` privately (default
`~/.local/share/maximal/config.json`; `COPILOT_API_HOME` can override its directory).
In the existing `mcpBroker.servers` entry with `id: "workiq"`, add the session-bus
name to `environment.inherit`, preserving other allowlisted names and settings:

```json
"environment": {
  "inherit": ["HOME", "DBUS_SESSION_BUS_ADDRESS"]
}
```

Do not replace the entire configuration, persist a fixed bus address, or copy
Microsoft tokens into it. If there is a fixed `environment.values` override for
the bus address, review/remove that stale override because it takes precedence
over inheritance. To reload the configuration while preserving client choices:

```sh
maximal mcp workiq --enable --unattended
```

Use `--port` if the running proxy uses a non-default port, and check that the CLI
reports the running Maximal picked up the change. This updates future sessions
without restarting the model proxy; reconnect the MCP client for a new session.
To undo the edit, restore only the relevant configuration from the backup,
preserve later unrelated changes, and reload again.

## Verify the boundary

Check `/status` for `subsystems.mcp_broker.state: "ready"` and connect your MCP
client to the Work IQ endpoint. Tool discovery after login should include
structured tools such as `fetch`, `get_schema`, and `search_paths`. A listing
limited to `accept_eula`, `ask`, and `list_agents` is a reason to check sign-in and
EULA state, not proof that the local package lacks structured tools. Counts can
vary with version and tenant policy.

Discovery proves transport/tool availability, not an actual M365 read or write.
Test a scoped read separately, with the user's permission, before claiming data
access. Writes need separate confirmation. Treat retrieved content as untrusted;
a skill's instructions are not an enforced permission boundary.
