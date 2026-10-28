/**
 * Stands in for the sidecar in the Windows containment test: it starts the
 * broker as the supervisor does, owns the broker's stdin and stdout, and
 * relays them, so ending this process closes the broker's stdin. It exits
 * with the broker's exit status.
 *
 *   containment-launcher.ts --job none|plain --pid-file <path>
 *     -- <command> [args...]
 *
 * With `--job plain` it first puts itself in a Job Object without limits, so
 * the broker starts inside an existing job and must nest its own job in it.
 * It then says on stderr whether the broker really is in that job.
 */
import { dlopen, FFIType } from "bun:ffi"
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"

import { loadKernel32 } from "../src/windows-job.ts"

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

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

const api = job === "plain" ? loadKernel32() : undefined
let jobHandle = 0n
if (api) {
  jobHandle = api.createJobObject()
  if (jobHandle === 0n) throw new Error("LAUNCHER_JOB_CREATE_FAILED")
  if (!api.assignProcess(jobHandle, api.currentProcess())) {
    throw new Error(`LAUNCHER_JOB_ASSIGN_FAILED error=${api.lastError()}`)
  }
}

const broker = spawn(command, commandArgs, {
  detached: true,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
})
if (broker.pid) writeFileSync(pidFile, String(broker.pid))
if (api && broker.pid) {
  const { symbols } = dlopen("kernel32.dll", {
    OpenProcess: {
      args: [FFIType.u32, FFIType.i32, FFIType.u32],
      returns: FFIType.u64,
    },
  })
  const process_ = BigInt(
    symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, broker.pid),
  )
  const inJob = process_ !== 0n && api.isProcessInJob(process_, jobHandle)
  process.stderr.write(
    `[containment-launcher] broker-in-job=${inJob ? "yes" : "no"}\n`,
  )
}
process.stdin.pipe(broker.stdin)
broker.stdout.pipe(process.stdout)
broker.stderr.pipe(process.stderr)
// "close" waits for the broker's output to be relayed.
broker.once("close", (code) => process.exit(code ?? 1))
