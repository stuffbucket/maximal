/**
 * Stands in for the sidecar in the Windows containment test: it starts the
 * broker as the supervisor does, owns the broker's stdin and stdout, and
 * relays them, so ending this process closes the broker's stdin. It exits
 * with the broker's exit status.
 *
 *   containment-launcher.ts --job none|plain|ui-limited --pid-file <path>
 *     -- <command> [args...]
 *
 * With `--job plain` it first puts itself in a Job Object without limits, so
 * the broker starts inside an existing job and its own job is nested in it.
 * With `--job ui-limited` that job has a UI limit, and Windows won't nest a
 * job under one that has UI limits, so the broker's containment must fail.
 */
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"

import { loadKernel32 } from "../src/windows-job.ts"

/** JOBOBJECTINFOCLASS JobObjectBasicUIRestrictions. */
const JOB_OBJECT_BASIC_UI_RESTRICTIONS = 4
/** Harmless to a test: the processes in the job can't log the user off. */
const JOB_OBJECT_UILIMIT_EXITWINDOWS = 0x80

const args = process.argv.slice(2)
const separator = args.indexOf("--")
const options = args.slice(0, separator)
const [command, ...commandArgs] = args.slice(separator + 1)
const option = (flag: string): string | undefined => {
  const index = options.indexOf(flag)
  return index === -1 ? undefined : options[index + 1]
}
const job = option("--job") ?? "none"
const pidFile = option("--pid-file")
if (separator === -1 || !command || !pidFile) {
  throw new Error("usage: --job <kind> --pid-file <path> -- <command> [args]")
}

if (job !== "none") {
  const api = loadKernel32()
  const handle = api.createJobObject()
  if (handle === 0n) throw new Error("LAUNCHER_JOB_CREATE_FAILED")
  // Assigned before the UI limit is set, so this nests under any job the
  // launcher is already in; the limit then stops anything nesting under it.
  if (!api.assignProcess(handle, api.currentProcess())) {
    throw new Error(`LAUNCHER_JOB_ASSIGN_FAILED error=${api.lastError()}`)
  }
  if (job === "ui-limited") {
    const limits = new Uint8Array(4)
    new DataView(limits.buffer).setUint32(
      0,
      JOB_OBJECT_UILIMIT_EXITWINDOWS,
      true,
    )
    if (
      !api.setInformation(handle, JOB_OBJECT_BASIC_UI_RESTRICTIONS, limits)
    ) {
      throw new Error(`LAUNCHER_JOB_UI_LIMIT_FAILED error=${api.lastError()}`)
    }
  }
}

const broker = spawn(command, commandArgs, {
  detached: true,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
})
if (broker.pid) writeFileSync(pidFile, String(broker.pid))
process.stdin.pipe(broker.stdin)
broker.stdout.pipe(process.stdout)
broker.stderr.pipe(process.stderr)
// "close" waits for the broker's output to be relayed.
broker.once("close", (code) => process.exit(code ?? 1))
