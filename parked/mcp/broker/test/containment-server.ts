/**
 * An MCP server for the Windows containment test: it starts a long-lived
 * child of its own, appends "<parent> <self> <child>" to the file named by
 * CONTAINMENT_PID_FILE, then serves the ordinary test fixture on stdio.
 */
import { spawn } from "node:child_process"
import { appendFileSync } from "node:fs"
import { resolve } from "node:path"

const pidFile = process.env.CONTAINMENT_PID_FILE
if (!pidFile) throw new Error("CONTAINMENT_PID_FILE is required")

const grandchild = spawn(
  process.execPath,
  [resolve(import.meta.dir, "containment-grandchild.ts")],
  { stdio: "ignore", windowsHide: true },
)
await new Promise<void>((resolveSpawn, rejectSpawn) => {
  grandchild.once("spawn", resolveSpawn)
  grandchild.once("error", rejectSpawn)
})
appendFileSync(pidFile, `${process.ppid} ${process.pid} ${grandchild.pid}\n`)

await import("./fixture.ts")
