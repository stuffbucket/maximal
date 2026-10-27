/**
 * Event-loop starvation watchdog for `bun test`, started by tests/test-setup.ts.
 *
 * Code spinning in a promise loop that never awaits a timer or I/O keeps the
 * main thread busy forever. Timers never fire, so Bun's per-test timeout can't
 * fail the test, and the SIGTERM handlers that runServer installs never run. CI
 * then hangs until the job timeout. This worker has its own event loop. The
 * main thread pings it every second, and if the pings stop for STARVATION_MS
 * the worker reports it and SIGKILLs the process so the run fails fast.
 *
 * MAXIMAL_TEST_STARVATION_MS overrides the limit; 0 disables the watchdog (for
 * example while paused in a debugger).
 */
import fs from "node:fs"

declare const self: Worker

const limitMs = Number(process.env.MAXIMAL_TEST_STARVATION_MS ?? 60_000)
let lastPing = Date.now()

self.addEventListener("message", () => {
  lastPing = Date.now()
})

setInterval(() => {
  const silentMs = Date.now() - lastPing
  if (silentMs < limitMs) return
  fs.writeSync(
    2,
    `\n[test watchdog] The bun test event loop hasn't turned for ${Math.round(silentMs / 1000)}s. `
      + "A test is spinning without yielding (an endless promise loop or a long "
      + "synchronous call), so per-test timeouts can't fire. Killing the run. "
      + "In CI the last test file group above was running; locally, rerun "
      + "suspect files one at a time to find it.\n",
  )
  process.kill(process.pid, "SIGKILL")
}, 1000)
