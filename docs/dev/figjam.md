# FigJam agent

The FigJam agent puts an agent panel inside FigJam. The panel talks to Maximal
for model calls and acts on the board through the Figma Plugin API. An optional
local bridge lets a coding agent on the same computer (Claude Code, scripts)
read and change the board through the same tools.

## Packages

| Package | What it holds |
|---|---|
| `packages/figjam-plugin` | The Figma plugin: the sandbox (`src/legacy/code.js`), the panel (`src/legacy/ui.html`), and `scripts/build.ts`, which writes an importable plugin folder. |
| `packages/figjam-bridge` | The bridge (`src/server.ts`, HTTP and WebSocket on port 4150; `src/bridge.ts` is its CLI entry), the chat store (`src/chats-store.ts`, SQLite with FTS5) and the `figjam` CLI (`src/cli.ts`). |
| `packages/plugin-figjam` | The built-in Maximal plugin (an `extension`, off by default) that runs the bridge in-process, writes the Figma development plugin and approves panels from Integrations. |
| `packages/figjam-layout` | Layout and edge routing for boards. The recommended pipeline is plain TypeScript; the older baseline strategies use elkjs and libavoid-js. |

The sandbox and panel are still the single-file sources they started as. The
build embeds them (text imports, so a compiled Maximal can write the plugin without the source tree), stamps `PLUGIN_VERSION` from
`packages/figjam-plugin/package.json`, and writes `manifest.json`.

## Use it from Maximal

1. Open Settings → Integrations, open **FigJam** and switch it on. It's off by
   default because it opens a local port (4150, changeable in its settings).
2. Click **Set up the Figma plugin**. Maximal builds the development plugin
   into `<app dir>/plugins/figjam/figma-plugin/` and shows the path of its
   `manifest.json`. On start, Maximal compares `manifest.json`, `code.js` and `ui.html` byte
   for byte with what a build would write (the ports and relay key it was
   given included), and rebuilds when any differs or is missing, even if the
   version and ports are unchanged. Other files in the folder are left alone.
   **Rebuild the Figma plugin** does it on demand. A rebuild writes all three
   files (owner-only) to temp names, then renames them into place. Each rename
   is atomic, but the three together
   are not: if a rename throws, the files already renamed are restored from
   their previous contents (or removed if they did not exist), so the folder
   is left as it was. A crash or power loss between renames can still leave a
   mix of old and new files; the next start finds the folder stale and
   rebuilds it. The relay key lasts as long as the Maximal process (plugin
   reloads keep it; see Who can connect), so after Maximal restarts, run the
   plugin again in Figma (a paired panel reconnects without asking again).
3. In the Figma desktop app: **Plugins → Development → Import plugin from
   manifest…**, then choose that `manifest.json`. Run **Maximal Agent (dev)**
   on a FigJam board and tick **Let Claude Code drive this board** in its
   Settings.
4. Maximal raises a notification, "A FigJam panel ("grumpy-lynx") on board
   "Roadmap" wants to connect.", and FigJam's page in Integrations lists the
   request with **Approve** and **Deny**. The status also shows the port, the
   connected boards and who's waiting, each with the board name, file key and
   Figma user the panel reported. The notice code is `figjam-pair-requested`
   (params `name` and `board`); it has no localized wording yet, so the English
   message is shown.

   The same request can be answered from the tray, without opening Settings.
   While a panel waits, the status carries `attention` (summary: `A FigJam panel
   ("name") on board "board" wants to connect`, actions: Approve and Deny), so the tray icon
   turns to its attention state and the menu (macOS menu bar, Windows
   notification-area right-click) starts with `FigJam: Approve "name"` and
   `FigJam: Deny "name"`. They disappear once the request is answered or
   expires. The action ids are stable per panel name (`approve-<name>-<hash>`,
   the name reduced to `a-z0-9-` plus a short hash of the exact name), so a
   menu item that has gone stale still targets the right panel.

If the port is taken (for example by `bun run figjam:bridge`), the status is an
error that names the port, with **Try again**. The plugin is
`packages/plugin-figjam`; it's a thin shell over `startBridge` and the
figjam-plugin build (see Embedding). It declares the bridge as the exclusive
resource `figjam-bridge:<port>`: `apply` registers actions and status without
opening the listener, `prepare` only checks that the transition is still live,
and `commit` tries to bind after the parent lease is held. During initial
activation, a bind failure retains that logical reservation and the operable
error/Retry surface; handoff and recovery commits rethrow bind failures because
they must prove readiness. `revoke` waits until sockets and the listener are
closed and the port is free, and `resume` binds the previous generation again
after a rejected handoff. A generation replacement therefore
prepares B, revokes A, then commits B; a pre-durable failure revokes B before A
resumes. The parent keeps the lease through child termination and authoritative reap; a
serving generation is then revived and rebound under that retained lease. It
releases the lease only after acknowledged revoke or final settled shutdown
when no revival is intended. The port the Figma plugin calls Maximal on is not
a setting: the plugin asks the host
(`ctx.host.maximalPort()`), which answers with the port Maximal is actually
serving on, and the folder is rebuilt when that changes. An old `maximalPort`
value in a saved config is ignored.

## Build and run the plugin (developers)

```sh
bun run figjam:build                  # → packages/figjam-plugin/dist/dev
bun run figjam:build -- --release     # → dist/release, named "Maximal Agent"
bun run figjam:build -- --watch       # rebuild when src/ changes
bun run figjam:build -- --out <dir> --maximal-port 4141 --bridge-port 4150
```

In the Figma desktop app: **Plugins → Development → Import plugin from
manifest…**, choose `dist/dev/manifest.json`, then run **Plugins → Development
→ Maximal Agent (dev)** on a FigJam board. Figma reads the files from that
folder each time the plugin starts, so a rebuild takes effect on the next run.
Development plugins run only in the desktop app, for the person who imported
them.

A plugin built by `figjam:build` carries no relay key, so its panel works with
Maximal but can't connect to a bridge (its Settings say so). To drive a board
from a coding agent, use the plugin the bridge's host writes: Maximal's (see
above), or the one `bun run figjam:bridge` writes (see The bridge).

The manifest is FigJam-only (`editorType: ["figjam"]`), uses
`documentAccess: "dynamic-page"`, and sets `enablePrivatePluginApi` so the
sandbox can read `figma.fileKey`. Network access is limited to Figma's REST
API (`https://api.figma.com`, for comments) through `allowedDomains`, and to
Maximal (`http://localhost:4141`) and the bridge (`ws://localhost:4150`)
through `devAllowedDomains`. Change the ports with the build flags. The build
stamps the same two ports, and the relay key when the bridge's host builds it,
into the panel's `PANEL_BUILD` line, so the panel's
model calls, bridge socket and the bridge address in its status text always
match the manifest allowlist. A Maximal address saved by an older panel (the
old `4141` default) follows the build's port.

In `scripts/build.ts`, `resolveBuildOptions` fills in the defaults and checks
the options (a release build drops the relay key; a malformed key is refused),
and `renderPlugin` turns the result into all three files: the manifest from
`pluginManifest` (which can't see the key), the panel stamp from `panelBuild`,
and `code.js`.
`buildPlugin` writes what `renderPlugin` returns, and `inspectPlugin` compares
a folder with it, so a new build option is added to `BuildOptions`, given its
default in `resolveBuildOptions`, and, if the panel needs it, added to
`PanelBuild` and `panelBuild`. Maximal's FigJam plugin passes the same
options (`#buildOptions()` in `packages/plugin-figjam/src/controller.ts`) to
both.

## Comments

The Plugin API can't see comments, so the sandbox calls Figma's REST API with
a personal access token. In the panel: **⋯ → Settings → Figma access token**.
The link beside the field opens Figma's account settings, where tokens are
created under Security → Personal access tokens. Grant `file_comments:read`,
`file_comments:write` and `file_content:read`.

The token is stored with `figma.clientStorage` on this computer. The panel
sees only whether a token is saved and its last four characters. Tool results,
errors, chats and bridge messages never include it. `run_code` can read
`figma.clientStorage`, which is one reason it's off unless the user turns on
**Allow run_code**.

With a token saved, the agent has three tools:

| Tool | Does |
|---|---|
| `get_comments` | Threads on this file, with author, text, the node a comment is pinned to, and reactions. Open threads only unless `includeResolved`. |
| `add_comment` | A new comment, a reply (`replyTo`), or a comment pinned to a node (`nodeId`). |
| `react_to_comment` | Adds an emoji reaction. |

Figma's REST API can't resolve comments, and there are no delete tools.

## The bridge

Developers can run the bridge without Maximal's plugin. Don't run both at once:
they'd compete for the port (and `startBridge` allows one bridge per process).

```sh
bun run figjam:bridge                 # serves :4150 (FIGJAM_BRIDGE_PORT overrides)
bun run figjam -- status              # connected boards
bun run figjam -- approve <name>      # approve a panel that asked to connect
bun run figjam -- tools               # tool schemas, as the plugin reports them
bun run figjam -- get_board '{}' --board <name>
```

`bun run figjam:bridge` also writes the development plugin for this run into
`packages/figjam-plugin/dist/dev` (`FIGJAM_PLUGIN_OUT` overrides), stamped
with the bridge's port and relay key. Import that `manifest.json`; after
restarting the bridge, run the plugin again.

`bun run figjam:build` writes to the same `dist/dev` by default, without a
key. Whichever ran last wins: a `figjam:build` (or `--watch` rebuild) after
starting the bridge leaves a panel that can't connect, and starting the
bridge overwrites an unkeyed build. Run `figjam:build` with `--out`, or the
bridge with `FIGJAM_PLUGIN_OUT`, to keep them apart.

### Who can connect

1. **Relay key.** Each bridge has a relay key: 32 random bytes, new for each
   process that owns it. Maximal makes one when it starts (`runServer`, before
   any plugin generation spawns) and hands it to every plugin generation
   through `MAXIMAL_FIGJAM_RELAY_KEY`, replacing any inherited value. So a
   Retry, a FigJam settings change, or an unrelated plugin inventory or
   settings reload (each starts a new generation) keeps the key and the
   plugin already imported; only restarting Maximal changes it. A plugin
   generation started without that parent (tests, another host) makes a key
   of its own. `figjam:bridge` makes one per run. The key
   lives in memory, in the environment Maximal passes its plugin generations
   (and anything they start), and in the `ui.html` the host writes (mode
   0600; never the manifest, a log, the status or the HTTP API). The panel
   offers it as its
   WebSocket subprotocol, and the bridge refuses an upgrade to `/plugin`
   without it (403) before any socket or pairing request exists. The Figma
   plugin iframe's origin is the opaque `null`, which any sandboxed frame on
   any web page can also send, so the origin check only rules out ordinary
   web pages. A key left on disk opens nothing once its process has ended.
2. **Approval.** Behind the key, a panel connects only when its user ticks
   **Let Claude Code drive this board** in the panel's Settings. Each panel instance has a name such as
`grumpy-lynx`, shown in the plugin's title bar. The first time it connects,
the bridge holds the request until someone approves that name (in Maximal's
Integrations page, or with `figjam approve <name>` from the CLI), or denies it. An approved panel gets a token of its
own and reconnects without asking again (it still needs the relay key: the
token doesn't stand in for it). Requests expire after five minutes
(`FIGJAM_PAIR_TTL_S`).

HTTP callers (the CLI, scripts) authenticate with the admin token. Browser
origins are refused.

Files live under Maximal's data directory, `<data>/figjam/`:

| File | Holds |
|---|---|
| `chats.sqlite` | Chats per board, searchable (FTS5) |
| `clients.json` | Approved panels (token hashes only, mode 0600) |
| `pairing-token` | The admin token for HTTP callers (mode 0600) |
| `exports/` | Images written by `export_png` |

`<data>` is `COPILOT_API_HOME` when set; otherwise `%APPDATA%\maximal` on
Windows, `$XDG_DATA_HOME/maximal`, or `~/.local/share/maximal`.

### Embedding

`startBridge` (`@stuffbucket/maximal-figjam-bridge/server`) runs the same
bridge in-process; Maximal's FigJam plugin and `bun run figjam:bridge` are
both thin wrappers around it.

```ts
const bridge = await startBridge({
  port: 0, // default FIGJAM_BRIDGE_PORT, else 4150; 0 picks a free port
  hostname: "127.0.0.1",
  dataDir, // default: the data directory described below
  relayKey, // default: createRelayKey(), new for this start
  onEvent: (e) => { /* BridgeEvent */ },
})
bridge.port
bridge.relayKey // stamp into the plugin you write (buildPlugin({ relayKey })); never log it
bridge.status() // { port, version, boards, pending, clients }
await bridge.approve("grumpy-lynx") // name optional when one request is pending
await bridge.deny("grumpy-lynx")
bridge.forget(clientId)
await bridge.stop() // closes sockets and the listener, frees the port
```

`approve` and `deny` return the admin API's JSON body plus `status` (the HTTP
status it would carry), so a miss reads `{ ok: false, status: 404, error }`.
`BridgeEvent` is one of `pair-requested` (`name`, `user?`, `board?`), `paired`
(`name`, `clientId`), `pair-denied`, `pair-expired`, `board-connected` and
`board-disconnected` (`name`, `board?`). State is module-level, so one bridge
per process: a second `startBridge` before `stop()` throws.

## Tests

```sh
bun run figjam:test        # CI runs this in unit-tests
bun run figjam:typecheck   # CI runs this in quality; check:fast includes it
```

- `figjam-plugin` builds into a temp folder, checks the manifest, the
  version stamp and the panel's build line (the relay key only in `ui.html`,
  files owner-only, never in a release build), then runs the stub tests in `test/sandbox/*.mjs` under Node.
  Each stub loads the built `code.js` in a `vm` context with a fake `figma`
  global. `panel-ports.mjs` does the same for the built `ui.html` with fake
  browser globals and checks, for default and non-default ports, that Maximal
  calls, the bridge socket and the status text use the stamped ports and
  agree with the manifest, that a keyed panel offers exactly its stamped key
  as the socket's subprotocol, and that an unkeyed one opens no socket and
  says why. They need Node rather than Bun, because Bun's `vm` doesn't keep a
  context's top-level `var` bindings in sync with the context object.
- `plugin-figjam` runs the plugin conformance suite, then the real bridge on a
  spare port with a temporary data directory: a fake panel holding the relay
  key from the plugin it built asks to pair, and
  the test checks the `figjam-pair-requested` notice, the Approve/Deny status
  actions and the `attention` that carries them (with action ids that stay
  the same for the same panel name), that approving pairs the panel and that
  it reconnects with its token without a new request, that a forged
  `Origin: null` socket without the key raises nothing, that the
  host's Maximal port reaches the built manifest's `devAllowedDomains`, the
  stale-folder rebuild (changed content with the same version and ports, a
  missing file, a panel stamped with other ports, and another relay key), the
  port-in-use error and that stopping the plugin
  frees the port. `relay-key.test.ts` runs two plugin generations as separate
  processes (what a plugin inventory or settings reload does) and checks they
  stamp the parent's key and leave the imported plugin unchanged, and that
  without the parent's key each would make its own. It runs with
  `bun run plugins:test`.
- `figjam-bridge` starts a bridge on a spare port with a temporary data
  directory and drives pairing the way the panel and the CLI do, both as a
  subprocess (the CLI path, reading the key from the plugin it wrote) and
  in-process through `startBridge`, including forged `Origin: null` sockets
  with no, wrong, truncated or padded keys, a web origin with the right key,
  token reconnects, and restarts with the same and a new key.
- `figjam-layout` runs the recommended pipeline on the capability-map fixture
  (about 10s): every hard check must pass, and its crossings, wire length and
  name-tag counts are pinned, so a routing change shows up as a deliberate
  update. It also covers `board_tree` conversion, the build gate, and the
  bridge client against a stand-in bridge.

## Layout engine

```sh
cd packages/figjam-layout
bun src/cli.ts map <layout.json> [outDir] [--policy A|B]   # the recommended pipeline only
bun src/cli.ts plan <layout.json> [outDir]                 # every strategy, scored side by side
```

See `packages/figjam-layout/README.md`. Plans and previews go to `out/`,
which git ignores.
