# FigJam agent

The FigJam agent puts an agent panel inside FigJam. The panel talks to Maximal
for model calls and acts on the board through the Figma Plugin API. An optional
local bridge lets a coding agent on the same computer (Claude Code, scripts)
read and change the board through the same tools.

## Packages

| Package | What it holds |
|---|---|
| `packages/figjam-plugin` | The Figma plugin: the sandbox (`src/legacy/code.js`), the panel (`src/legacy/ui.html`), and `scripts/build.ts`, which writes an importable plugin folder. |
| `packages/figjam-bridge` | The bridge (`src/server.ts`, HTTP and WebSocket, preferred port 4150, walking upward when it is taken; `src/bridge.ts` is its CLI entry), the chat store (`src/chats-store.ts`, SQLite with FTS5) and the `figjam` CLI (`src/cli.ts`). |
| `packages/plugin-figjam` | The built-in Maximal plugin (an `extension`, off by default) that runs the bridge in-process, writes the Figma development plugin and approves panels from Integrations. |
| `packages/figjam-layout` | Layout and edge routing for boards. The recommended pipeline is plain TypeScript; the older baseline strategies use elkjs and libavoid-js. |

The sandbox and panel are still the single-file sources they started as. The
build embeds them (text imports, so a compiled Maximal can write the plugin without the source tree), stamps `PLUGIN_VERSION` from
`packages/figjam-plugin/package.json`, and writes `manifest.json`.

## Use it from Maximal

1. Open Settings → Integrations, open **FigJam** and switch it on. It's off by
   default because it opens a local port (preferred 4150, changeable in its
   settings; the next free port is used when it's taken).
2. Click **Set up the Figma plugin**. Maximal builds the development plugin
   into `<app dir>/plugins/figjam/figma-plugin/` and shows the path of its
   `manifest.json`. See "One plugin per Maximal profile" below for what the
   plugin is called. On start, Maximal compares `manifest.json`, `code.js` and `ui.html` byte
   for byte with what a build would write (Maximal's port, the relay key and
   the profile it was given included), and rebuilds when any differs or is
   missing, even if the version and port are unchanged. The bridge's own port
   is not one of those inputs (see "How the panel reaches the bridge"), so a
   bridge that moves ports never touches the folder. Other files in the folder are left alone.
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
   manifest…**, then choose that `manifest.json`. Run the plugin the status
   names under **Figma plugin** (**Maximal Agent (dev)**, with a profile id
   after "dev" in a development profile) on a FigJam board and tick **Let Claude Code drive this board** in its
   Settings.
4. Maximal raises a notification, "A FigJam panel ("grumpy-lynx") on board
   "Roadmap" wants to connect.", and FigJam's page in Integrations shows a
   notice with **Review request**. That opens one dialog, "Let the FigJam panel
   "grumpy-lynx" connect?", that names the panel, the board, its file key and
   the Figma profile the panel reported, and says approving lets that panel
   read and change the board. **Approve** pairs it; **Deny** refuses it for
   good (use it for a request you didn't expect or from the wrong profile);
   **Not now**, Escape or a click on the backdrop leave it waiting (it expires
   after five minutes). Focus starts on Not now. With several waiting, the next
   opens after each answer. The status also shows the port, the connected
   boards and who's waiting, each with the board name, file key and Figma user
   the panel reported. The notice code is `figjam-pair-requested` (params
   `name` and `board`); it has no localized wording yet, so the English message
   is shown. The dialog is the generic `status.attention.requests` (see
   Architecture → Attention), so its wording comes from
   `packages/plugin-figjam/src/status.ts`.

   The same request can be answered from the tray, without opening Settings.
   While a panel waits, the status carries `attention` (summary: `A FigJam panel
   ("name") on board "board" wants to connect`, `actions`: Approve and Deny for
   the tray, `requests`: the dialog's question), so the tray icon
   turns to its attention state and the menu (macOS menu bar, Windows
   notification-area right-click) starts with `FigJam: Approve "name"` and
   `FigJam: Deny "name"`. They disappear once the request is answered or
   expires. The status's own actions don't repeat Approve and Deny. The action
   ids are stable per panel name (`approve-<name>-<hash>`,
   the name reduced to `a-z0-9-` plus a short hash of the exact name), so a
   menu item that has gone stale still targets the right panel.

If the preferred port is taken (for example by `bun run figjam:bridge`), the
bridge uses the next free port above it and the status shows both (**Port** and
**Preferred port (in use)**). The Figma plugin doesn't change: the panel
reaches the bridge through Maximal, which follows the bridge to its new port.
Only when 64 ports in a row are taken is the status an error that names the
port, with **Try again**. Point the `figjam` CLI at the port the status shows
(`--port`). The plugin is
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

## How the panel reaches the bridge

The panel connects through Maximal's own HTTP origin and nothing else, so the
Figma manifest names only Maximal and never goes stale when the bridge's port
changes: a bridge that walks to another port, restarts or is replaced by a new
plugin generation never rebuilds the plugin. Everything below is served by the
parent Maximal process (the bridge itself runs in the FigJam plugin's
generation child process and listens on a loopback port of its own, which is
internal to the panel's path).

| Route | Does |
|---|---|
| `GET /figjam/bridge.json` | JSON metadata: `{ service: "maximal-figjam-bridge", schema: 1, available, reason?, profile: { kind, id }, maximal: { version }, panel: { path } }`. `available: false` comes with a `503` and a `reason` (`disabled`, `starting`, `error`, `unavailable`). It carries no bridge port, no URL to the bridge, no token, no key and no path on disk. |
| `GET /figjam/plugin` | WebSocket upgrade (`ws://localhost:<maximal port>/figjam/plugin`). The panel offers its relay key as the WebSocket subprotocol, which the server selects and echoes. `src/lib/figjam/relay.ts` then opens the bridge's own `/plugin` socket, offering the bridge the same key, and copies frames both ways, passing the bridge's close codes through (pairing denied, expired, unpaired). It never reads a frame, so the pairing token and tool calls stay between the panel and the bridge. Pre-open and socket backpressure are bounded at 64 MiB; overflow closes both peers instead of dropping frames. |

### The relay key at each hop

One key, #677's process-lifetime capability (see "Who can connect"), is checked
at every hop and never replaced by a weaker check:

1. **Panel to Maximal.** `bridge.json` answers a loopback caller only (anyone
   else gets a plain 404). A request without `Origin`, as local CLI
   diagnostics send, may read the discovery document (it holds nothing
   secret). An opaque browser request (`Origin: null`) must present the key in
   `x-maximal-figjam-relay-key`; `Origin: null` alone is not trusted because
   any sandboxed opaque-origin frame can send it. Other browser origins are
   refused. The socket is stricter: `/figjam/plugin` **always** needs the key
   as its subprotocol, whatever the `Origin`, so a local process can't use the
   relay to reach the bridge (a missing, wrong, truncated or padded key is
   refused before any upgrade; the comparison is constant-time). The routes
   read the key from `MAXIMAL_FIGJAM_RELAY_KEY` on every request; with none,
   nothing opens.
2. **Maximal to the bridge.** The relay offers the bridge the same key as its
   subprotocol (the parent's own copy, only after the panel proved it holds it).
   The bridge's enforcement is exactly #677's: it refuses a `/plugin` upgrade
   without the key (403) before any socket or pairing request exists, relayed
   or not.
3. **Panel to bridge, after the socket opens.** Pairing is unchanged: the
   `hello` and its approval or token pass through the relay untouched.

The key is never in the manifest, a URL, a response or a log. The routes need
no normal API key (a WebSocket can't send one), like `/mcp`.

The panel asks `bridge.json` first (so "FigJam is switched off", "this plugin
was built for another profile", "Maximal doesn't know this plugin's key" (it
restarted since the plugin was run: run the plugin again) and "this Maximal is
too old" are said instead of timing out), then opens the socket on the origin
it is configured for. The panel's Maximal address defaults to the port stamped
into the build and has to be one the manifest allows. A panel without a key
(an unkeyed `figjam:build`) asks nothing and opens nothing.

A standalone bridge (`bun run figjam:bridge`) isn't reachable through Maximal.
To drive a panel from one, the plugin it writes is built with
`--bridge-port <port>`: the manifest then also allows `ws://localhost:<port>`
and the panel connects there directly, offering that bridge's key.

### Is Maximal's own port stable?

It decides the one origin in the manifest, so a change there does force a
rebuild (the next start finds the folder stale and rewrites it; run the plugin
again). In practice:

- **Production** always uses 4141 (the shell sets it; if the port is taken the
  sidecar refuses to start rather than move).
- **`bun run app:dev`** asks the OS for a port once, persists it in that
  worktree's profile and reuses it on every launch. It changes only when the
  persisted port can't be bound at launch (another program took it), in which
  case the shell drops it and picks a new one.
- **`maximal start`** uses 4141 unless `--port` says otherwise (`--port 0`
  picks a different port every run).

## One plugin per Maximal profile

Figma keys a development plugin's saved data (`clientStorage`: panel settings,
the Maximal address, the bridge pairing token, the Figma access token) by the
`id` in its manifest. Every `bun run app:dev` worktree is its own Maximal
profile, with its own data directory, its own persisted Maximal port and its
own bridge pairings, so profiles must not share a plugin id.

- The plugin learns its profile from `MAXIMAL_INSTANCE_ID`, the app identifier
  the shell sets (the plugin runner inherits it): production
  (`co.stuffbucket.maximal`), a development profile
  (`co.stuffbucket.maximal.dev.maximal-<12 hex>`, the worktree's persisted id),
  or neither (`bun run dev`, tests: "local"). `packages/plugin-figjam/src/profile.ts`
  owns that.
- A development profile builds `maximal-figjam-agent-dev-<id>`, named
  **Maximal Agent (dev <first 8 of the id>)**. Production and local runs keep
  the shared `maximal-figjam-agent-dev` / **Maximal Agent (dev)**. The status's
  **Figma plugin** line shows the name.
- The folder doesn't move: it's `<app dir>/plugins/figjam/figma-plugin/` in
  that profile's own data directory, so one **Import plugin from manifest…**
  per profile stays valid across restarts and rebuilds. A changed profile id
  rewrites the same folder (the profile is part of the manifest, so the
  byte-for-byte check sees it).

## Diagnostics and logs

Development profiles (`development` and `local`) log the detail below;
production logs only warnings and errors plus what the bridge has always
printed, and sends the rest to the debug level. Nothing logged contains a
token, a pairing code, a relay key, a credential or a board's content.

- The bridge: which port it bound and which were taken; with `verbose` (or
  `FIGJAM_BRIDGE_DEBUG=1`) also refused browser callers, missing or wrong admin
  tokens, and a `hello` carrying a token this bridge doesn't know (the panel was
  paired with another profile's bridge, or its pairing was forgotten).
- The plugin: bind and port moves, why the Figma folder is stale and when it was
  rebuilt, pairing requests, approvals, denials, expiries and connections by
  panel name.
- Maximal's routes: discovery requests, a panel built for another profile or
  another Maximal port (a manifest mismatch), refused origins and keys, an
  unavailable bridge, relay upgrades and the bridge's close codes.
- The panel: in a development build the Figma console (**Plugins →
  Development → Open console**) says why discovery failed, which socket it
  tried, a manifest that doesn't allow the origin, a wrong profile, an unknown
  pairing token and every close code. A release build stays silent.

## Build and run the plugin (developers)

```sh
bun run figjam:build                  # → packages/figjam-plugin/dist/dev
bun run figjam:build -- --release     # → dist/release, named "Maximal Agent"
bun run figjam:build -- --watch       # rebuild when src/ changes
bun run figjam:build -- --profile <id>   # a profile-specific plugin id and name
bun run figjam:build -- --out <dir> --maximal-port 4141
bun run figjam:build -- --bridge-port 4150  # also allow a standalone bridge
```

In the Figma desktop app: **Plugins → Development → Import plugin from
manifest…**, choose `dist/dev/manifest.json`, then run **Plugins → Development
→ Maximal Agent (dev)** on a FigJam board. Figma reads the files from that
folder each time the plugin starts, so a rebuild takes effect on the next run.
Development plugins run only in the desktop app, for the person who imported
them.

A plugin built by `figjam:build` carries no relay key, so its panel works with
Maximal for models but can't ask for the bridge or connect to it (its Settings
say so). To drive a board
from a coding agent, use the plugin the bridge's host writes: Maximal's (see
above), or the one `bun run figjam:bridge` writes (see The bridge).

The manifest is FigJam-only (`editorType: ["figjam"]`), uses
`documentAccess: "dynamic-page"`, and sets `enablePrivatePluginApi` so the
sandbox can read `figma.fileKey`. Network access is limited to Figma's REST
API (`https://api.figma.com`, for comments) through `allowedDomains`, and to
Maximal (`http://localhost:4141` and `ws://localhost:4141`, the one origin the
panel talks to) through `devAllowedDomains`. A build adds a bridge socket only
with `--bridge-port` (a standalone bridge). Change the Maximal port with
`--maximal-port`. The build stamps the Maximal port, the bridge port (0 when
Maximal relays the bridge), the relay key when the bridge's host builds it, the
profile and a dev flag into the panel's `PANEL_BUILD` line, so the panel's
model calls, discovery request, bridge socket and the address in its status
text always match the manifest allowlist. A Maximal address saved by an older panel (the
old `4141` default) follows the build's port.

In `scripts/build.ts`, `resolveBuildOptions` fills in the defaults and checks
the options (a release build drops the relay key; a malformed key is refused),
and `renderPlugin` turns the result into all three files: the manifest from
`pluginManifest` (which can't see the key; its id and name come from
`pluginIdentity`, which a development `profile` changes), the panel stamp from
`panelBuild`,
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

Developers can run the bridge without Maximal's plugin. It's then reachable
only by the CLI and agents, and by the panel of the plugin it writes (see "How
the panel reaches the bridge"). Running both is fine: whichever starts second
walks upward from 4150 to a free port, so point the CLI at the one you mean
with `--port` (Maximal's status shows its **Port**). `startBridge` allows one
bridge per process.

```sh
bun run figjam:bridge                 # serves :4150 (FIGJAM_BRIDGE_PORT overrides)
bun run figjam -- status              # connected boards
bun run figjam -- approve <name>      # approve a panel that asked to connect
bun run figjam -- tools               # tool schemas, as the plugin reports them
bun run figjam -- get_board '{}' --board <name>
```

`bun run figjam:bridge` also writes the development plugin for this run into
`packages/figjam-plugin/dist/dev` (`FIGJAM_PLUGIN_OUT` overrides), stamped
with the bridge's port (so its manifest allows that socket) and relay key. Import that `manifest.json`; after
restarting the bridge, run the plugin again.

`bun run figjam:build` writes to the same `dist/dev` by default, without a
key. Whichever ran last wins: a `figjam:build` (or `--watch` rebuild) after
starting the bridge leaves a panel that can't connect, and starting the
bridge overwrites an unkeyed build. Run `figjam:build` with `--out`, or the
bridge with `FIGJAM_PLUGIN_OUT`, to keep them apart.

### Who can connect

1. **Relay key.** Each bridge has a relay key: 32 random bytes, new for each
   process that owns it. Maximal makes one as the first step of `runServer`,
   before any plugin generation spawns, and sets it in its own environment as
   `MAXIMAL_FIGJAM_RELAY_KEY`, replacing any inherited value. Plugin
   generations inherit it from there. So a
   Retry, a FigJam settings change, or an unrelated plugin inventory or
   settings reload (each starts a new generation) keeps the key and the
   plugin already imported; only restarting Maximal changes it. A plugin
   generation started without that parent (tests, another host) makes a key
   of its own. `figjam:bridge` makes one per run. The key
   lives in memory; in Maximal's own process environment, which every process
   Maximal starts inherits (plugin generations, and also anything else it
   launches, such as clients and MCP servers, all running as the same user);
   and in the `ui.html` the host writes (mode
   0600; never the manifest, a log, the status or the HTTP API). It guards
   against web pages, not other processes of the same user, which could read
   that `ui.html` anyway. The panel
   offers it as its WebSocket subprotocol to Maximal's relay, which offers it
   on to the bridge (see "The relay key at each hop"), and the bridge refuses
   an upgrade to `/plugin` without it (403) before any socket or pairing
   request exists. The Figma
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
| `clients.json` | Approved panels (token hashes only, mode 0600). Embedded and standalone bridge processes coordinate updates with a short-lived cross-process lock and atomic rename, so approve, forget and `lastSeen` changes cannot overwrite one another. |
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
  port: 0, // preferred: default FIGJAM_BRIDGE_PORT, else 4150; 0 picks any free port
  portAttempts: 64, // ports tried upward from `port` when it's taken (1 = never walk)
  verbose: false, // development logging (default: FIGJAM_BRIDGE_DEBUG=1)
  hostname: "127.0.0.1",
  dataDir, // default: the data directory described below
  relayKey, // default: createRelayKey(), new for this start
  onEvent: (e) => { /* BridgeEvent */ },
})
bridge.port // the port actually bound
bridge.preferredPort // the one asked for; differs when it was taken
bridge.relayKey // stamp into the plugin you write (buildPlugin({ relayKey })); never log it
bridge.status() // { port, preferredPort, version, boards, pending, clients, activity }
await bridge.approve("grumpy-lynx") // name optional when one request is pending
await bridge.deny("grumpy-lynx")
bridge.forget(clientId)
await bridge.stop() // closes sockets and the listener, frees the port
```

`approve` and `deny` return the admin API's JSON body plus `status` (the HTTP
status it would carry), so a miss reads `{ ok: false, status: 404, error }`.
`BridgeEvent` is one of `pair-requested` (`name`, `user?`, `board?`), `paired`
(`name`, `clientId`), `pair-denied`, `pair-expired`, `board-connected` and
`board-disconnected` (`name`, `board?`), plus `tool-started` and
`tool-finished` (the tool's name and times only, never its input; they feed
`status().activity`, which the plugin passes on as `PluginStatus.activity` for
the Sessions view). State is module-level, so one bridge
per process: a second `startBridge` before `stop()` throws.

## Tests

```sh
bun run figjam:test        # CI runs this in unit-tests
bun run figjam:typecheck   # CI runs this in quality; check:fast includes it
```

- `figjam-plugin` builds into a temp folder, checks the manifest, the
  version stamp and the panel's build line (the relay key only in `ui.html`,
  files owner-only, never in a release build) and the header's Maximal mark
  (one labelled, self-contained SVG whose "m" is byte-for-byte the outlined
  "m" of `shell/maximal-wordmark.svg`, colored by the panel's brand tokens),
  then runs the stub tests in `test/sandbox/*.mjs` under Node.
  Each stub loads the built `code.js` in a `vm` context with a fake `figma`
  global. `panel-ports.mjs` does the same for the built `ui.html` with fake
  browser globals and checks, for default and non-default Maximal ports and
  for a standalone bridge's port, that Maximal calls, the discovery request,
  the socket and the status text use the stamped ports and agree with the
  manifest (Maximal's origin only, plus a standalone bridge's socket only when
  the build names one), that a keyed panel offers exactly its stamped key (the
  socket's subprotocol, and one discovery header, never the URL, the status or
  the console), that an unkeyed one sends no discovery request, opens no
  socket and says why, and that discovery answers for another profile, an
  unknown key (403) or a switched-off FigJam stop the panel with a reason. They need Node rather than Bun, because Bun's `vm` doesn't keep a
  context's top-level `var` bindings in sync with the context object.
- `plugin-figjam` runs the plugin conformance suite, then the real bridge on a
  spare port with a temporary data directory: a fake panel holding the relay
  key from the plugin it built asks to pair, and
  the test checks the `figjam-pair-requested` notice, the Approve/Deny status
  actions and the `attention` that carries them (with action ids that stay
  the same for the same panel name), that approving pairs the panel and that
  it reconnects with its token without a new request, that a forged
  `Origin: null` socket without the key raises nothing, that the
  host's Maximal port (and only that origin, with no bridge port) reaches the
  built manifest's `devAllowedDomains`, that a bridge port that moves leaves the
  plugin files byte-identical and untouched (even after a deliberate rebuild), the
  stale-folder rebuild (changed content with the same version and port, a
  missing file, a panel stamped with another Maximal port, and another relay key),
  the port walk (a taken port moves the bridge and the status says so) and its
  no-free-port error, the attention
  `requests` dialog (naming the panel, board, file and Figma profile, with the
  same ids as the tray's actions and no Approve/Deny among the status's own
  actions), the profile-specific plugin id and name, development and
  production logging, tool activity in the status (`activity.test.ts`,
  `profile.test.ts`) and that stopping the plugin frees the port. `relay-key.test.ts` runs two plugin generations as separate
  processes (what a plugin inventory or settings reload does) and checks they
  stamp the parent's key and leave the imported plugin unchanged, and that
  without the parent's key each would make its own. It runs with
  `bun run plugins:test`.
- `figjam-bridge` starts a bridge on a spare port with a temporary data
  directory and drives pairing the way the panel and the CLI do, both as a
  subprocess (the CLI path, reading the key from the plugin it wrote) and
  in-process through `startBridge`, including the preferred-port walk,
  tool-activity counters (`activity.test.ts`) and concurrent processes
  approving, forgetting and updating the same `clients.json` including
  stale-lock recovery (`clients-concurrency.test.ts`), and forged `Origin: null` sockets
  with no, wrong, truncated or padded keys, a web origin with the right key,
  token reconnects, and restarts with the same and a new key.
- `tests/figjam-route.test.ts` (the root suite, `bun test`) covers Maximal's
  `/figjam/*` routes: the availability read from the plugin's status, the
  discovery JSON (and that it holds no port, path or key), loopback and origin
  checks, and the relay key at each hop. A forged `Origin: null` socket, no
  `Origin` at all, and a wrong, truncated or padded key are all refused before
  anything reaches the bridge; a stand-in bridge that enforces its relay key as
  #677's does shows the relay offers it exactly that key; and a real bridge
  pairs a panel through the relay while a keyless socket can't create a pairing
  request. It also pins that the routes' and the plugin's names for the key, the
  status port fact and the profile agree, and the relay's flow control.
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
