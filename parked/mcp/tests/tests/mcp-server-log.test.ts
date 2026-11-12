import { describe, expect, test } from "bun:test"

import {
  BrokerStderrLog,
  createLineSplitter,
} from "~/lib/mcp-broker/server-log"

function fakeLogger() {
  const lines: Array<{ level: string; text: string }> = []
  const at =
    (level: string) =>
    (...args: Array<unknown>) =>
      lines.push({ level, text: args.join(" ") })
  return {
    lines,
    logger: { info: at("info"), warn: at("warn"), error: at("error") },
  }
}

describe("broker stderr in Maximal's log", () => {
  test("logs a server's line under its endpoint and keeps the last problem", () => {
    const { lines, logger } = fakeLogger()
    const log = new BrokerStderrLog(logger, () => 1000)
    log.record("[endpoint:workiq] Starting up")
    log.record(
      "[endpoint:workiq] [MCP Proxy] Failed to fetch remote tools: Unauthorized",
    )
    log.record("[endpoint:workiq] Listening")

    expect(lines).toEqual([
      { level: "info", text: "workiq: Starting up" },
      {
        level: "info",
        text: "workiq: [MCP Proxy] Failed to fetch remote tools: Unauthorized",
      },
      { level: "info", text: "workiq: Listening" },
    ])
    expect(log.lastProblem("workiq")).toEqual({
      line: "[MCP Proxy] Failed to fetch remote tools: Unauthorized",
      at: 1000,
    })
    expect(log.lastProblem("other")).toBeUndefined()
  })

  test("logs the broker's own codes as warnings", () => {
    const { lines, logger } = fakeLogger()
    new BrokerStderrLog(logger).record("[maximal-mcp-broker] SESSION_EVICTED")
    expect(lines).toEqual([
      { level: "warn", text: "[maximal-mcp-broker] SESSION_EVICTED" },
    ])
  })

  test("forgets an endpoint's last problem on request", () => {
    const { logger } = fakeLogger()
    const log = new BrokerStderrLog(logger)
    log.record("[endpoint:workiq] error: AADSTS65001 consent required")
    expect(log.lastProblem("workiq")?.line).toContain("AADSTS65001")
    log.forget("workiq")
    expect(log.lastProblem("workiq")).toBeUndefined()
  })

  test("writes a bounded number of lines a minute", () => {
    const { lines, logger } = fakeLogger()
    let now = 0
    const log = new BrokerStderrLog(logger, () => now)
    for (let i = 0; i < 500; i++) log.record(`[endpoint:workiq] error ${i}`)
    const written = lines.length
    expect(written).toBeLessThan(500)
    // Problems are still tracked while the log is quiet.
    expect(log.lastProblem("workiq")?.line).toBe("error 499")
    now = 60_000
    log.record("[endpoint:workiq] later")
    expect(lines.length).toBe(written + 2)
    expect(lines.at(-2)?.text).toContain("dropped")
  })
})

describe("splitting a stream into lines", () => {
  test("joins chunks and drops blank lines", () => {
    const lines: Array<string> = []
    const push = createLineSplitter((line) => lines.push(line))
    push(Buffer.from("one\ntw"))
    push(Buffer.from("o\r\n\nthree"))
    expect(lines).toEqual(["one", "two"])
    push(Buffer.from("\n"))
    expect(lines).toEqual(["one", "two", "three"])
  })
})
