// Windows diagnostic for the adapter test: reads the first line of stdin
// one way and writes "got <line>" to stdout, so the test can see which ways
// work when the parent isn't Bun.
//
//   bun stdin-probe.ts process-stdin | bun-stdin | fs-stream | fs-read
import fs from "node:fs"

const method = process.argv[2]
const reply = (text: string) => {
  process.stdout.write(`got ${text.trim()}\n`)
  setTimeout(() => process.exit(0), 100)
}

if (method === "process-stdin") {
  let buffered = ""
  process.stdin.on("data", (chunk: Buffer) => {
    buffered += chunk.toString()
    if (buffered.includes("\n")) reply(buffered.split("\n")[0] ?? "")
  })
} else if (method === "bun-stdin") {
  const reader = Bun.stdin.stream().getReader()
  let buffered = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffered += new TextDecoder().decode(value)
    if (buffered.includes("\n")) {
      reply(buffered.split("\n")[0] ?? "")
      break
    }
  }
} else if (method === "fs-stream") {
  let buffered = ""
  fs.createReadStream("", { fd: 0 }).on("data", (chunk) => {
    buffered += chunk.toString()
    if (buffered.includes("\n")) reply(buffered.split("\n")[0] ?? "")
  })
} else if (method === "fs-read") {
  const buffer = Buffer.alloc(4096)
  const read = fs.readSync(0, buffer, 0, buffer.length, null)
  reply(buffer.subarray(0, read).toString().split("\n")[0] ?? "")
}
