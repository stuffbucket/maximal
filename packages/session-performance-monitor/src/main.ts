#!/usr/bin/env bun

import { readFile } from "node:fs/promises"
import { monitorMaximal } from "./monitor"
import { parsePolicy, parseRecording } from "./recording"
import type { AnalysisReport, MonitorPolicy, MonitorRecording } from "./types"

interface CliOptions {
  command: "monitor" | "analyze"
  input?: string
  baseUrl: string
  sessionId?: string
  client: string
  samples: number
  intervalMs: number
  timeoutMs: number
  policyPath?: string
  json: boolean
}

const usage = `Usage:
  session-performance-monitor monitor [options]
  session-performance-monitor analyze <recording.json> [options]

Options:
  --base-url <url>       Maximal URL (default: http://127.0.0.1:4141)
  --session <id>         Exact session ID; otherwise selects latest client session
  --client <name>        Client for automatic selection (default: claude-code)
  --samples <count>      Samples to collect (default: 8)
  --interval-ms <ms>     Delay between samples (default: 60000)
  --timeout-ms <ms>      Per-request timeout (default: 10000)
  --policy <file>        JSON object overriding deterministic thresholds
  --json                 Emit the complete recording as JSON
  --help                 Show this help

MAXIMAL_API_KEY supplies authentication when the target is not loopback.
Exit code 2 means the deterministic policy produced an action recommendation.
`

const numericOption = (
  name: string,
  value: string | undefined,
  minimum: number,
): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`)
  }
  return parsed
}

const parseArgs = (args: readonly string[]): CliOptions => {
  const values = [...args]
  let command: CliOptions["command"] = "monitor"
  let input: string | undefined
  if (values[0] === "monitor" || values[0] === "analyze") {
    command = values.shift() as CliOptions["command"]
  }
  if (command === "analyze" && values[0] && !values[0].startsWith("--")) {
    input = values.shift()
  }

  const options: CliOptions = {
    command,
    input,
    baseUrl: "http://127.0.0.1:4141",
    client: "claude-code",
    samples: 8,
    intervalMs: 60_000,
    timeoutMs: 10_000,
    json: false,
  }
  while (values.length > 0) {
    const flag = values.shift()
    if (flag === "--help") {
      process.stdout.write(usage)
      process.exit(0)
    }
    if (flag === "--json") {
      options.json = true
      continue
    }
    const value = values.shift()
    if (!value) throw new Error(`Missing value for ${flag}`)
    switch (flag) {
      case "--base-url":
        options.baseUrl = value
        break
      case "--session":
        options.sessionId = value
        break
      case "--client":
        options.client = value
        break
      case "--samples":
        options.samples = numericOption(flag, value, 1)
        break
      case "--interval-ms":
        options.intervalMs = numericOption(flag, value, 0)
        break
      case "--timeout-ms":
        options.timeoutMs = numericOption(flag, value, 1)
        break
      case "--policy":
        options.policyPath = value
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }
  if (command === "analyze" && !input) {
    throw new Error("analyze requires a recording JSON file")
  }
  return options
}

const readPolicy = async (path: string): Promise<MonitorPolicy> => {
  const value: unknown = JSON.parse(await readFile(path, "utf8"))
  return parsePolicy(value)
}

const readRecording = async (
  path: string,
  policy?: MonitorPolicy,
): Promise<MonitorRecording> => {
  const value: unknown = JSON.parse(await readFile(path, "utf8"))
  return parseRecording(value, `file://${path}`, policy)
}

const percentage = (value: number | null): string =>
  value === null ? "unknown" : `${(value * 100).toFixed(1)}%`

const number = (value: number | null): string =>
  value === null ? "unknown" : Math.round(value).toLocaleString("en-US")

const printReport = (report: AnalysisReport): void => {
  const lines = [
    `Session: ${report.sessionId}`,
    `Client/model: ${report.client} / ${report.model}`,
    `Samples: ${report.sampleCount} (${report.observedFrom} to ${report.observedTo})`,
    `Verdict: ${report.verdict}`,
    `Context: ${percentage(report.metrics.contextRatio)} (${number(report.metrics.contextHeadroomTokens)} tokens headroom)`,
    `Context growth: ${number(report.metrics.contextGrowthTokensPerMinute)} tokens/min`,
    `Context ETA: ${number(report.metrics.contextLimitEtaMinutes)} min`,
    `Token throughput: ${number(report.metrics.tokenThroughputPerMinute)} tokens/min`,
    `Cache-read share: ${percentage(report.metrics.cacheReadShare)}`,
    `Compactions observed: ${report.metrics.compactionCount}`,
  ]
  for (const observation of report.observations) lines.push(`Note: ${observation}`)
  if (report.recommendations.length === 0) {
    lines.push("Recommendation: no operating-procedure change")
  } else {
    for (const recommendation of report.recommendations) {
      lines.push(
        `Recommendation [${recommendation.severity}/${recommendation.code}]: ${recommendation.message}`,
      )
      for (const evidence of recommendation.evidence) {
        lines.push(`  - ${evidence}`)
      }
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`)
}

const main = async (): Promise<void> => {
  const options = parseArgs(Bun.argv.slice(2))
  const policy =
    options.policyPath ? await readPolicy(options.policyPath) : undefined
  const recording =
    options.command === "analyze" ?
      await readRecording(options.input!, policy)
    : await monitorMaximal({
        baseUrl: options.baseUrl,
        sampleCount: options.samples,
        intervalMs: options.intervalMs,
        sessionId: options.sessionId,
        client: options.client,
        apiKey: process.env.MAXIMAL_API_KEY,
        timeoutMs: options.timeoutMs,
        policy,
        onSample: options.json ? undefined : (sample, index, total) => {
          process.stderr.write(
            `sample ${index}/${total}: ${sample.sampledAt} ${sample.sessionId}\n`,
          )
        },
      })
  if (options.json) {
    process.stdout.write(`${JSON.stringify(recording, null, 2)}\n`)
  } else {
    printReport(recording.report)
  }
  if (recording.report.verdict === "action") process.exitCode = 2
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`session-performance-monitor: ${message}\n`)
    process.exitCode = 1
  })
}
