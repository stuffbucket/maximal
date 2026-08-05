# maximal client — reference supervisor

Minimal Electron main process that spawns the `maximal-core` sidecar and drives
its control plane. **Reference material, not a finished client** — it exists to
show the integration seam working end-to-end so the real client (epic #417)
doesn't have to rediscover it.

## What it demonstrates

```
sidecarSpawnEnv()  ->  spawn --port 0  ->  awaitReadyLine  ->  ControlClient
```

Four things here are load-bearing and easy to get wrong:

- **`--port 0`.** A supervised sidecar must never claim 4141; that belongs to a
  user-run engine serving external tools (#408). The bound port is only knowable
  from the ready-line.
- **Keep draining stdout after readiness.** `awaitReadyLine` leaves the stream
  open on purpose; stop reading and the pipe buffer fills and blocks the child.
- **Isolated `COPILOT_API_HOME`.** The desktop engine is a separate instance and
  must not fight the user's own `maximal start` (maximal-core#2).
- **The renderer never learns the port.** It names a method and main forwards
  it, so a compromised page cannot reach the engine directly.

## Not done

Auth UI (#409), packaging (#412), i18n (#413), tray/updates, and any real
window design. The `MAXIMAL_SIDECAR_PATH` env var is the hook for a packaged
binary; in dev it runs core from the installed dependency's source.

## Verifying it

```
bun run e2e:app
```

Launches the **real** app — real window, real preload bridge, real renderer —
and drives it from outside over the Chrome DevTools Protocol. Nothing in `src/`
is stubbed or aware the harness exists; there is no alternate UI and no
test-only code path, so what passes is the shipping app. It asserts the full
chain in one go:

```
Electron main -> spawn sidecar -> ready-line -> bound port
  -> IPC bridge -> renderer -> JSON-RPC -> rendered state
```

Needs a window server (a normal login session), so it is not runnable over a
bare SSH connection. Core's own seams are covered separately by `bun run e2e`
in `maximal-core`; this is the layer above them, and it is what notices a
client that passes every unit test and still paints a blank window.

It found one real bug on its first negative run: an engine that failed to start
left the app alive with no window and no message, because nothing caught the
rejection from `startSidecar` — the carefully-worded errors it raises were
being discarded. That path now surfaces a dialog and exits.
