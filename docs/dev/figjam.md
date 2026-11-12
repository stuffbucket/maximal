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
| `packages/figjam-layout` | Layout and edge routing for boards. The recommended pipeline is plain TypeScript; the older baseline strategies use elkjs and libavoid-js. |

The sandbox and panel are still the single-file sources they started as. The
build copies them through, stamps `PLUGIN_VERSION` from
`packages/figjam-plugin/package.json`, and writes `manifest.json`.

## Build and run the plugin

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

The manifest is FigJam-only (`editorType: ["figjam"]`), uses
`documentAccess: "dynamic-page"`, and sets `enablePrivatePluginApi` so the
sandbox can read `figma.fileKey`. Network access is limited to Figma's REST
API (`https://api.figma.com`, for comments) through `allowedDomains`, and to
Maximal (`http://localhost:4141`) and the bridge (`ws://localhost:4150`)
through `devAllowedDomains`. Change the ports with the build flags.

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
the bridge holds the request until someone approves that name with
`figjam approve <name>`, or denies it. An approved panel gets a token of its
own and reconnects without asking again. Requests expire after five minutes
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
bridge in-process; `bun run figjam:bridge` is a thin wrapper around it.

```ts
const bridge = await startBridge({
  port: 0, // default FIGJAM_BRIDGE_PORT, else 4150; 0 picks a free port
  hostname: "127.0.0.1",
  dataDir, // default: the data directory described below
  onEvent: (e) => { /* BridgeEvent */ },
})
bridge.port
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

- `figjam-plugin` builds into a temp folder, checks the manifest and the
  version stamp, then runs the stub tests in `test/sandbox/*.mjs` under Node.
  Each stub loads the built `code.js` in a `vm` context with a fake `figma`
  global. They need Node rather than Bun, because Bun's `vm` doesn't keep a
  context's top-level `var` bindings in sync with the context object.
- `figjam-bridge` starts a bridge on a spare port with a temporary data
  directory and drives pairing the way the panel and the CLI do, both as a
  subprocess (the CLI path) and in-process through `startBridge`.
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
