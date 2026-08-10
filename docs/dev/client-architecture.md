# Client architecture — `client/`

`client/` is the Electron + React + TypeScript desktop application. It
composes the `stuffbucket-electron` shell and supervises a bundled
`maximal-core` sidecar.

## Process boundary

| Directory | Process | Responsibility |
|---|---|---|
| `client/src/main/` | Electron main | Sidecar supervision, private control transport, native operations, window and app lifecycle |
| `client/src/preload/` | Isolated preload | The only `contextBridge.exposeInMainWorld` call; publishes the closed `window.maximal` API |
| `client/src/renderer/` | Sandboxed renderer | React surfaces and narrow capability adapters |
| `client/src/shared/` | Main/preload shared code | Serializable bridge types and channel allowlists |

The packaged window must run with:

```text
contextIsolation: true
nodeIntegration: false
sandbox: true
```

Those settings come from `stuffbucket-electron`'s `createHostWindow`. The
packaged E2E suite reads the effective preferences from the live window so a
dependency update cannot weaken them silently.

## Sidecar and ports

`client/src/main/core.ts` spawns the bundled `maximal-core` executable with
`start`, waits for its structured ready line, and keeps draining its output.
The ready line provides two separate listeners:

- The **public proxy** serves `/v1/*` for external programs. The client does
  not pass `--port`, so core prefers `4141` and follows its normal next-port
  policy if that port is occupied.
- The **private control listener** serves JSON-RPC and SSE on an ephemeral
  loopback port. Its origin is retained in Electron main and never crosses
  preload.

The window is created before core starts so First-run can display live boot
status. `awaitControlOrigin()` and `awaitProxyUrl()` wait for `ready` rather
than returning an empty value during this expected startup interval.

`CoreStatus` covers `starting`, `boot-status`, `ready`, `crashed`,
`restarting`, `failed`, and `stopped`. Unexpected exits use bounded retries
with delays of 1, 2, 5, 10, and 20 seconds. A restarted process must remain
alive for 30 seconds before its retry budget resets, preventing a process
that repeatedly dies just after readiness from restarting forever.

The sidecar is app-scoped. On macOS, closing the last window leaves it alive
for Dock reactivation; a real quit stops it. Other platforms quit and stop it
when the last window closes.

## Closed control bridge

ADR-0024 places the private control boundary in Electron main. The renderer
does not receive a control origin, discovery response, raw control snapshot,
IPC channel name, arbitrary RPC method, or `ipcRenderer`.

`client/src/main/control-session.ts` owns the control transport:

1. Wait for the current private origin.
2. Use a short-lived client for `server/discover`.
3. Validate protocol version, `maximal-core` identity, feed support, and the
   required methods.
4. Create one live `ControlClient` for that sidecar generation and start one
   SSE connection.
5. On a new ready origin, discover and install one replacement, detach and
   close the old client, and ignore callbacks from stale generations.

A same-origin ready event is a no-op. Control-state changes are broadcast as
a payload-free invalidation hint; renderers re-read the named query they
need. The raw `ControlState` never crosses IPC.

Core RPC errors cross Electron IPC as serializable `ControlResult<T>` values
because Electron does not preserve custom `Error` fields reliably. The bridge
retains message, reason, retryability, request ID, remediation URL, and code.
Renderer adapters use `unwrapControlResult()` to reconstruct a local
`ControlCallError`.

### Preload API

`client/src/preload/index.ts` exposes exactly:

```ts
window.maximal = {
  getCoreStatus,
  onCoreStatus,
  getProxyUrl,
  openExternal,
  control: {
    authStatus,
    authStart,
    authCancel,
    authSignOut,
    accountsList,
    accountsSwitch,
    onChange,
  },
}
```

Lifecycle state is mapped through `toLifecycleStatus()`. Its ready variant
contains the public `proxyUrl` and process ID, but not `controlOrigin`.
Preload wraps event callbacks so `IpcRendererEvent` does not reach renderer
code, and each unsubscribe removes only its own listener.

There is no generic control-call channel. Operations without a current UI
consumer—including `accounts/remove`, `app/quit`, `app/upgrade`, config,
model, client, usage, and update methods—have no renderer capability.

`client/eslint.config.mjs` prevents renderer code from importing the core
control client, raw control contract, or IPC channel constants. Components
must use their surface capability interface; only the corresponding adapter
may touch `window.maximal`.

## Renderer composition

`App.tsx` creates long-lived adapters once, checks auth through the Settings
capability, and renders First-run until authenticated. A control-change event
is the fast refresh path; existing three-second polls remain safety nets for
missed notifications. Authenticated users can switch between Dashboard,
Runs, and Settings.

- `first-run/` implements resumable device-code authentication and maps the
  redacted lifecycle feed to its narrower `BootPhase` model.
- `settings/` exposes auth status/actions, account listing/switching, and the
  public proxy URL.
- `workspace/` presents project, status, run, and inspector views.
- `dashboard/` derives fleet totals, project rollups, recent completions, and
  waiting-on-user items from the same `WorkspaceSource` model.

First-run and Settings adapters delegate only to named preload methods. Main
owns restart recovery, so a stable renderer subscription survives control
client replacement without learning the new private origin.

## Placeholder data

`WorkspaceSource` is either `placeholder` or `live`. There is no live source
until core supplies durable project/run state (tracked by
`stuffbucket/maximal#432` and `stuffbucket/maximal-core#109`). Placeholder
records are deterministic, visibly named as placeholders, and accompanied by
persistent notices in Workspace and Dashboard. Fabricated fleet data must
never look live.

Completed and failed `AgentRun` records carry `finishedAt`; Dashboard orders
recent completions by that value rather than array position.

## Shell dependency

The client composes structural primitives from
`stuffbucket-electron/renderer`; it does not duplicate the shell package.
Host styles consume `--shell-*` custom properties with fallbacks because the
package intentionally supplies no product palette.

`ghostty-web` remains a direct client dependency even though the current
surfaces do not render a terminal. The shell's single renderer barrel
re-exports terminal components, and the bundler must resolve that graph before
tree-shaking.

## Verification

- Vitest separates Node/main tests from jsdom/renderer tests. Main, preload,
  lifecycle mapping, control generations, error transport, capability
  adapters, and UI behavior are covered.
- ESLint enforces React hooks, basic syntax rules, and the renderer import
  boundary. It is intentionally not type-aware while the client uses
  TypeScript 7 and the supported `typescript-eslint` line cannot load it.
- TypeScript validates the complete main/preload/renderer contract.
- Packaged Playwright tests launch a relocated copy outside the repository's
  dependency tree. They verify sidecar readiness, the exact deep preload API,
  absence of `window.require`, effective sandbox preferences, primary-heading
  and visual invariants, and clean shutdown without an orphaned sidecar.
- `.github/workflows/client-ci.yml` runs unit gates on Linux and packages plus
  exercises the app on macOS.

A packaged test must never launch the in-place app under `client/out/`.
`relocatePackagedApp()` copies it to a fresh external directory, verifies the
copy, and ensures no ancestor contains `node_modules`; otherwise tests could
resolve unshipped dependencies and validate an artifact users never receive.

## Known gaps

- Workspace and Dashboard still have no live project/run source.
- Workspace and Dashboard each compose a full `ShellLayout`; the app-level
  view switcher and each surface's internal navigation are not yet one shared
  frame.
- Client linting is not type-aware pending TypeScript 7 support in the lint
  toolchain or an explicit decision to maintain a shadow compiler.
- Destructive and process-lifecycle control operations remain deliberately
  absent. Adding one requires a named main/preload capability and appropriate
  confirmation UX; it cannot be reached through a generic dispatcher.
