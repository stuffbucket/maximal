import { describe, expect, it } from "bun:test"

import {
  createStderrForwarder,
  formatServerStderr,
  SERVER_STDERR_MAX_LINE_CHARS,
  SERVER_STDERR_MAX_LINES,
} from "../src/server-stderr.ts"

const collect = (now: () => number = () => 0) => {
  const lines: Array<string> = []
  const forward = createStderrForwarder((line) => lines.push(line), now)
  return { lines, forward }
}

describe("server stderr forwarding", () => {
  it("passes complete lines on, joining a line split across chunks", () => {
    const { lines, forward } = collect()
    forward(Buffer.from("[MCP Proxy] Failed to fetch "))
    forward(Buffer.from("remote tools: 401\nsecond"))
    expect(lines).toEqual(["[MCP Proxy] Failed to fetch remote tools: 401"])
    forward(Buffer.from(" line\r\n\n"))
    expect(lines).toEqual([
      "[MCP Proxy] Failed to fetch remote tools: 401",
      "second line",
    ])
  })

  it("strips terminal escapes and control characters", () => {
    const { lines, forward } = collect()
    forward("\u001b[31mwarn\u001b[0m: bad\u0007 thing\n")
    expect(lines).toEqual(["warn: bad thing"])
  })

  it("shortens a very long line", () => {
    const { lines, forward } = collect()
    forward(`${"x".repeat(SERVER_STDERR_MAX_LINE_CHARS * 3)}\n`)
    expect(lines[0]).toHaveLength(SERVER_STDERR_MAX_LINE_CHARS)
    expect(lines[0]?.endsWith("…")).toBe(true)
  })

  it("passes on a bounded number of lines a minute, then says how many it dropped", () => {
    let now = 0
    const { lines, forward } = collect(() => now)
    for (let i = 0; i < SERVER_STDERR_MAX_LINES + 5; i++) forward(`line ${i}\n`)
    expect(lines).toHaveLength(SERVER_STDERR_MAX_LINES)

    now = 60_000
    forward("after\n")
    expect(lines.slice(SERVER_STDERR_MAX_LINES)).toEqual([
      "(5 lines dropped)",
      "after",
    ])
  })

  it("tags each line with its endpoint for Maximal to read", () => {
    expect(formatServerStderr("workiq", "hello")).toBe(
      "[endpoint:workiq] hello\n",
    )
  })
})
