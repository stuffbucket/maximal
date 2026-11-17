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
   default because it opens a local port for the bridge's HTTP API (preferred
   4150, changeable in its settings; the next free port is used when it's taken).
2. Click **Set up the Figma plugin**. Maximal builds the development plugin
   into `<app dir>/plugins/figjam/figma-plugin/` and shows the path of its
   `manifest.json`. The folder is rebuilt on start when any of its files differs
   from what a build would write (content, not just version or port), and
   **Rebuild the Figma plugin** does it on demand. See "One plugin per Maximal
   profile" below for where it lives and what it's called.
3. In the Figma desktop app: **Plugins → Development → Import plugin from
   manifest…**, then choose that `manifest.json`. Run the plugin the status
   names under **Figma plugin** (**Maximal Agent (dev)**, with a profile id
   after "dev" in a development profile) on a FigJam board and tick **Let Claude Code drive this board** in its
   Settings.
4. Maximal raises a notification, "A FigJam panel ("grumpy-lynx") wants to
   connect.", and FigJam's page in Integrations shows a notice with **Review
   request**. That opens one dialog, "Let the FigJam panel "grumpy-lynx"
   connect?", that names the panel, the board it is open on and the Figma
   profile, and says approving lets that panel read and change the board.
   **Approve** pairs it; **Deny** refuses it for good (use it for a request you
   didn't expect or from the wrong profile); **Not now**, Escape or a click on
   the backdrop leave it waiting (it expires after five minutes). Focus starts
   on Not now. With several waiting, the next opens after each answer. The
   status also shows the port, the connected boards and who's waiting. The
   notice code is `figjam-pair-requested` (param `name`); it has no localized
   wording yet, so the English message is shown. The dialog is the generic
   `status.attention.requests` (see Architecture → Attention), so its wording
   comes from `packages/plugin-figjam/src/status.ts`.

   The same request can be answered from the tray, without opening Settings.
   While a panel waits, the status carries `attention` (summary: `A FigJam panel
   ("name") wants to connect`, `actions`: Approve and Deny for the tray,
   `requests`: the dialog's question), so the tray icon
   turns to its attention state and the menu (macOS menu bar, Windows
   notification-area right-click) starts with `FigJam: Approve "name"` and
   `FigJam: Deny "name"`. They disappear once the request is answered or
   expires. The action ids are stable per panel name (`approve-<name>-<hash>`,
   the name reduced to `a-z0-9-` plus a short hash of the exact name), so a
   menu item that has gone stale still targets the right panel.

If the preferred port is taken (for example by `bun run figjam:bridge`), the
bridge uses the next free port above it and the status shows both (**Port**
and **Preferred port (in use)**). Only when 64 ports in a row are taken is the
status an error, with **Try again**. The plugin is
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
changes. Everything below is served by the parent Maximal process (the bridge
itself runs in the FigJam plugin's generation child process and listens on a
loopback port of its own, which is internal to the panel's path).

| Route | Does |
|---|---|
| `GET /figjam/bridge.json` | JSON metadata: `{ service: "maximal-figjam-bridge", schema: 1, available, reason?, profile: { kind, id }, maximal: { version }, panel: { path } }`. `available: false` comes with a `503` and a `reason` (`disabled`, `starting`, `error`, `unavailable`). It carries no bridge port, no URL to the bridge, no token and no path on disk. The opaque-origin panel presents its per-process relay capability in `x-maximal-figjam-relay-key`. |
| `GET /figjam/plugin` | WebSocket upgrade (`ws://localhost:<maximal port>/figjam/plugin`). The panel presents the same capability as a WebSocket subprotocol, which the server selects and echoes. `src/lib/figjam/relay.ts` copies frames both ways to the bridge's own `/plugin` socket and passes the bridge's close codes through (pairing denied, expired, unpaired). It never reads a frame, so the pairing token and tool calls stay between the panel and the bridge. Pre-open and socket backpressure are bounded at 64 MiB; overflow closes both peers instead of dropping frames. |

The parent learns where the bridge listens from the plugin's own status (its
**Port** fact), reading it on every request, so a generation handoff or a
restart is followed without any cache. Both routes answer only callers on this
computer (anyone else gets a plain 404). A request without `Origin`, as local
CLI diagnostics send, may proceed; an opaque browser request (`Origin: null`)
must also present the fresh per-process relay capability stamped into that
profile's staged `ui.html`. `Origin: null` alone is not trusted because any
sandboxed opaque-origin frame can send it. Other browser origins are refused.
The capability is never put in the manifest, a URL, a response or a log. The
routes need no normal API key (a WebSocket can't send one), like `/mcp`.

The panel asks `bridge.json` first (so "FigJam is switched off", "this plugin
was built for another profile" and "this Maximal is too old" are said instead
of timing out), then opens the socket on the origin it is configured for. The
panel's Maximal address defaults to the port stamped into the build and has to
be one the manifest allows.

A standalone bridge (`bun run figjam:bridge`) isn't reachable through Maximal.
To drive a panel from one, build the plugin with `--bridge-port <port>`: the
manifest then also allows `ws://localhost:<port>` and the panel connects there
directly.

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
  that profile's own data directory (for `app:dev`, the persisted Tauri profile
  for the worktree), so one **Import plugin from manifest…** per profile
  stays valid across restarts, rebuilds and port changes. A changed profile id
  or panel build rewrites the same folder. A partially populated folder (for
  example, one imported build file was deleted) is stale and is repaired on
  startup; only a wholly absent folder remains first-time setup.
- The panel is stamped with the profile it was built for (`PANEL_BUILD` in
  `ui.html`, written by `scripts/build.ts`) and refuses a Maximal whose
  `bridge.json` names another profile, so a plugin imported from one profile
  can't pair with another's bridge.

## Diagnostics and logs

Development profiles (`development` and `local`) log the detail below;
production logs only warnings and errors plus what the bridge has always
printed, and sends the rest to the debug level. Nothing logged contains a
token, a pairing code, a credential or a board's content.

- The bridge: which port it bound and which were taken; with `verbose` (or
  `FIGJAM_BRIDGE_DEBUG=1`) also refused browser callers, missing or wrong admin
  tokens, and a `hello` carrying a token this bridge doesn't know (the panel was
  paired with another profile's bridge, or its pairing was forgotten).
- The plugin: bind and port moves, why the Figma folder is stale and when it was
  rebuilt, pairing requests, approvals, denials, expiries and connections by
  panel name.
- Maximal's routes: discovery requests, a panel built for another profile or
  another Maximal port (a manifest mismatch), refused origins, an unavailable
  bridge, relay upgrades and the bridge's close codes.
- The panel: in a development build the Figma console (**Plugins →
  Development → Open console**) says why discovery failed, which socket it
  tried, a manifest that doesn't allow the origin, a wrong profile, an unknown
  pairing token and every close code. A release build stays silent.

## Build and run the plugin (developers)

```sh
bun run figjam:build                  # → packages/figjam-plugin/dist/dev
bun run figjam:build -- --release     # → dist/release, named "Maximal Agent"
bun run figjam:build -- --watch       # rebuild when src/ changes
bun run figjam:build -- --out <dir> --maximal-port 4141
bun run figjam:build -- --profile <id>   # a profile-specific plugin id and name
bun run figjam:build -- --bridge-port 4150  # also allow a standalone bridge
```

In the Figma desktop app: **Plugins → Development → Import plugin from
manifest…**, choose `dist/dev/manifest.json`, then run **Plugins → Development
→ Maximal Agent (dev)** on a FigJam board. Figma reads the files from that
folder each time the plugin starts, so a rebuild takes effect on the next run.
Development plugins run only in the desktop app, for the person who imported
them.

The manifest is FigJam-only (`editorType: ["figjam"]`), uses
`documentAccess: "dynamic-page"`, and sets `enablePrivatePluginApi` so the
sandbox can read `figma.fileKey`. Network access is limited to Figma's REST
API (`https://api.figma.com`, for comments) through `allowedDomains`, and to
Maximal (`http://localhost:4141` and `ws://localhost:4141`, the one origin the
panel talks to) through `devAllowedDomains`. A build adds a bridge socket only
with `--bridge-port` (a standalone bridge). Change the Maximal port with
`--maximal-port`.

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

Developers can run the bridge without Maximal's plugin. It's then reachable only by
the CLI and agents (and by a panel built with `--bridge-port`; see "How the
panel reaches the bridge"). Running both is fine: whichever starts second walks
upward from 4150 to a free port, so point the CLI at the one you mean with
`--port` (Maximal's status shows its **Port**). `startBridge` allows one
bridge per process.

```sh
bun run figjam:bridge                 # serves :4150 (FIGJAM_BRIDGE_PORT overrides)
bun run figjam -- status              # connected boards
bun run figjam -- approve <name>      # approve a panel that asked to connect
bun run figjam -- tools               # tool schemas, as the plugin reports them
bun run figjam -- get_board '{}' --board <name>
```

A panel connects only when its user ticks **Let Claude Code drive this board**
in the panel's Settings. Each panel instance has a name such as
`grumpy-lynx`, shown in the plugin's title bar. The first time it connects,
the bridge holds the request until someone approves that name (in Maximal's
Integrations page, or with `figjam approve <name>` from the CLI), or denies it. An approved panel gets a token of its
own and reconnects without asking again. Requests expire after five minutes
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
  onEvent: (e) => { /* BridgeEvent */ },
})
bridge.port // the port actually bound
bridge.preferredPort // the one asked for; differs when it was taken
bridge.status() // { port, preferredPort, version, boards, pending, clients, activity }
await bridge.approve("grumpy-lynx") // name optional when one request is pending
await bridge.deny("grumpy-lynx")
await bridge.forget(clientId)
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

- `figjam-plugin` builds into a temp folder, checks the manifest, the panel's build line
  (ports, profile) and the
  version stamp, then runs the stub tests in `test/sandbox/*.mjs` under Node.
  Each stub loads the built `code.js` in a `vm` context with a fake `figma`
  global. They need Node rather than Bun, because Bun's `vm` doesn't keep a
  context's top-level `var` bindings in sync with the context object.
- `plugin-figjam` runs the plugin conformance suite, then the real bridge on a
  spare port with a temporary data directory: a fake panel asks to pair, and
  the test checks the `figjam-pair-requested` notice, the `attention` that
  carries the tray's Approve/Deny actions and the dialog's request (naming the
  panel and board, with action ids that stay the same for the same panel name,
  and no Approve/Deny among the status's own actions), that approving pairs the
  panel, that the host's Maximal port (and only that origin) reaches the built
  manifest's `devAllowedDomains`, the content-based stale-folder rebuild (an
  edited panel or manifest, not just an old version), that a moved bridge port
  leaves the folder alone, the profile-specific plugin id and name, development
  and production logging, the port walk and its no-free-port error, and that
  stopping the plugin frees the port. It runs with
  `bun run plugins:test`.
- `figjam-bridge` starts a bridge on a spare port with a temporary data
  directory and drives pairing the way the panel and the CLI do, both as a
  subprocess (the CLI path) and in-process through `startBridge`. It checks the
  preferred-port choice and walk upward, overlapping-call expiry and labels,
  and concurrent processes approving, forgetting and updating the same
  `clients.json` (including stale-lock recovery).
- `tests/figjam-route.test.ts` (the root suite, `bun test`) covers Maximal's
  `/figjam/*` routes: the availability read from the plugin's status, the
  discovery JSON (and that it holds no port or path), loopback/origin/relay-key
  refusals, WebSocket subprotocol selection, bounded queue and backpressure,
  and the relay between a real HTTP server and both a stand-in and the real
  bridge, including a panel pairing through it and close codes passing through. `tests/build-sidecar-sources.test.ts` pins that the sidecar
  rebuilds when any `plugin-*`, `figjam-*` or `connector-kit` package changes.
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
