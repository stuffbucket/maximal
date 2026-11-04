// A stdio MCP client that is Node, as Claude Desktop is: it starts the
// command with piped stdio, writes each line of a JSON array of messages to
// its stdin (waiting for the reply to each request before the next), and
// prints {"replies": [...]} with every reply line it got, as JSON.
//
//   node pipe-session.mjs <timeoutMs> <messagesJson> <command> [args...]
import { spawn } from "node:child_process"

const [timeoutMs, messagesJson, command, ...args] = process.argv.slice(2)
const messages = JSON.parse(messagesJson)
const child = spawn(command, args, {
  stdio: ["pipe", "pipe", "inherit"],
  windowsHide: true,
})
const replies = []
let buffered = ""
let waiting
const finish = () => {
  process.stdout.write(`${JSON.stringify({ replies })}\n`)
  child.kill()
  process.exit(0)
}
child.stdout.setEncoding("utf8")
child.stdout.on("data", (chunk) => {
  buffered += chunk
  for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
    const line = buffered.slice(0, end).replace(/\r$/u, "")
    buffered = buffered.slice(end + 1)
    if (!line) continue
    replies.push(line)
    waiting?.()
  }
})
child.on("exit", finish)
setTimeout(finish, Number(timeoutMs))

for (const message of messages) {
  const reply =
    JSON.parse(message).id === undefined ?
      Promise.resolve()
    : new Promise((resolve) => {
        waiting = resolve
      })
  child.stdin.write(`${message}\n`)
  await reply
}
finish()
