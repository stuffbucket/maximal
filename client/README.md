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
