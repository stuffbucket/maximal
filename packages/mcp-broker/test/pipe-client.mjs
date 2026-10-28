// A stdio client that isn't Bun, for the Windows adapter test: Node, as
// Claude Desktop (Electron) is. It starts the command with piped stdio,
// writes `line` plus a newline to its stdin, and prints the first line the
// command writes to stdout as JSON: {"line": "..."}, or {"timeout": true}.
//
//   node pipe-client.mjs <timeoutMs> <line> <command> [args...]
import { spawn } from "node:child_process"

const [timeoutMs, line, command, ...args] = process.argv.slice(2)
const child = spawn(command, args, {
  stdio: ["pipe", "pipe", "inherit"],
  windowsHide: true,
})
let buffered = ""
const finish = (result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`)
  child.kill()
  process.exit(0)
}
child.stdout.setEncoding("utf8")
child.stdout.on("data", (chunk) => {
  buffered += chunk
  const end = buffered.indexOf("\n")
  if (end !== -1) finish({ line: buffered.slice(0, end) })
})
child.on("exit", (code) => finish({ exited: code }))
setTimeout(() => finish({ timeout: true }), Number(timeoutMs))
child.stdin.write(`${line}\n`)
