import path from "node:path"

import { discoverRunningAppDev } from "../../../../scripts/app-dev-prepare"

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..")

const OPERATIONS = [
  "decisions",
  "systemone",
  "images.generate",
  "images.edit",
] as const

export type SmokeOperation = (typeof OPERATIONS)[number]

const IMAGE_CREDITS: Readonly<Record<SmokeOperation, number>> = {
  decisions: 0,
  systemone: 0,
  "images.generate": 0.6,
  "images.edit": 1.4,
}

export interface SmokeOptions {
  baseUrl: URL
  operations: ReadonlyArray<SmokeOperation>
  confirmLive: boolean
  allowImageSpend: boolean
  maxPlannedImageCredits?: number
  outDir?: string
  negativeProbes: boolean
  apiKey?: string
}

export class UsageError extends Error {}

export function usage(): string {
  return [
    "Usage:",
    "  bun .claude/skills/live-operation-smoke/scripts/smoke.ts [--base-url URL] [options]",
    "",
    "Options:",
    "  --operations LIST                 decisions,systemone,images.generate,images.edit",
    "  --confirm-live                    acknowledge live model POSTs",
    "  --allow-image-spend               separately acknowledge image spend",
    "  --max-planned-image-credits N     required image-spend estimate ceiling",
    "  --out-dir PATH                    new directory required for image artifacts",
    "  --negative-probes                 expect no-upstream 404 route probes",
    "  --allow-remote                    allow a non-loopback target",
    "  --allow-insecure-http             allow HTTP for a remote target",
    "",
    "Local target:",
    "  With no URL, discover the running app:dev instance for this worktree.",
    "",
    "Environment:",
    "  MAXIMAL_BASE_URL                  explicit target override",
    "  MAXIMAL_API_KEY                   optional Maximal client API key",
  ].join("\n")
}

function takeFlagValue(
  argv: ReadonlyArray<string>,
  index: number,
  seen: Set<string>,
): string {
  const flag = argv[index]
  if (seen.has(flag)) throw new UsageError(`Duplicate flag: ${flag}`)
  seen.add(flag)
  if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
    throw new UsageError(`Missing value for ${flag}`)
  }
  return argv[index + 1]
}

function parseOperations(value: string): Array<SmokeOperation> {
  const values = value.split(",").map((item) => item.trim())
  if (values.length === 0 || values.includes("")) {
    throw new UsageError(
      "--operations must be a non-empty comma-separated list",
    )
  }
  const unique = new Set<string>()
  for (const operation of values) {
    if (!(OPERATIONS as ReadonlyArray<string>).includes(operation)) {
      throw new UsageError(`Unknown operation: ${operation}`)
    }
    if (unique.has(operation)) {
      throw new UsageError(`Duplicate operation: ${operation}`)
    }
    unique.add(operation)
  }
  return values as Array<SmokeOperation>
}

function normalizeBaseUrl(
  value: string,
  allowRemote: boolean,
  allowInsecureHttp: boolean,
): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new UsageError(`Invalid base URL: ${value}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError("Base URL must use HTTP or HTTPS")
  }
  if (
    url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new UsageError(
      "Base URL must be an origin only, without credentials, path, query, or fragment",
    )
  }
  const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]).has(
    url.hostname,
  )
  if (!loopback && !allowRemote) {
    throw new UsageError("A non-loopback target requires --allow-remote")
  }
  if (!loopback && url.protocol === "http:" && !allowInsecureHttp) {
    throw new UsageError(
      "Remote plain HTTP requires --allow-insecure-http as well as --allow-remote",
    )
  }
  url.pathname = "/"
  return url
}

export function plannedImageCredits(
  operations: ReadonlyArray<SmokeOperation>,
): number {
  return operations.reduce(
    (total, operation) => total + IMAGE_CREDITS[operation],
    0,
  )
}

interface ParsedFlags {
  baseUrlValue?: string
  operations: Array<SmokeOperation>
  confirmLive: boolean
  allowImageSpend: boolean
  maxPlannedImageCredits?: number
  outDir?: string
  negativeProbes: boolean
  allowRemote: boolean
  allowInsecureHttp: boolean
}

function emptyFlags(): ParsedFlags {
  return {
    operations: [],
    confirmLive: false,
    allowImageSpend: false,
    negativeProbes: false,
    allowRemote: false,
    allowInsecureHttp: false,
  }
}

/* eslint-disable complexity -- strict CLI parsing keeps every consequential flag explicit */
function parseFlags(argv: ReadonlyArray<string>): ParsedFlags {
  const parsed = emptyFlags()
  const seen = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    switch (flag) {
      case "--base-url": {
        parsed.baseUrlValue = takeFlagValue(argv, index, seen)
        index += 1
        break
      }
      case "--operations": {
        parsed.operations = parseOperations(takeFlagValue(argv, index, seen))
        index += 1
        break
      }
      case "--max-planned-image-credits": {
        const value = Number(takeFlagValue(argv, index, seen))
        if (!Number.isFinite(value) || value < 0) {
          throw new UsageError(
            "--max-planned-image-credits must be a non-negative number",
          )
        }
        parsed.maxPlannedImageCredits = value
        index += 1
        break
      }
      case "--out-dir": {
        parsed.outDir = takeFlagValue(argv, index, seen)
        index += 1
        break
      }
      case "--confirm-live":
      case "--allow-image-spend":
      case "--negative-probes":
      case "--allow-remote":
      case "--allow-insecure-http": {
        if (seen.has(flag)) throw new UsageError(`Duplicate flag: ${flag}`)
        seen.add(flag)
        switch (flag) {
          case "--confirm-live": {
            parsed.confirmLive = true
            break
          }
          case "--allow-image-spend": {
            parsed.allowImageSpend = true
            break
          }
          case "--negative-probes": {
            parsed.negativeProbes = true
            break
          }
          case "--allow-remote": {
            parsed.allowRemote = true
            break
          }
          default: {
            parsed.allowInsecureHttp = true
          }
        }
        break
      }
      case "--help":
      case "-h": {
        throw new UsageError(usage())
      }
      default: {
        throw new UsageError(`Unknown argument: ${flag}`)
      }
    }
  }
  return parsed
}
/* eslint-enable complexity */

function validateFlags(parsed: ParsedFlags): void {
  const imageCredits = plannedImageCredits(parsed.operations)
  if (parsed.operations.length > 0 && !parsed.confirmLive) {
    throw new UsageError("Live operations require --confirm-live")
  }
  const editIndex = parsed.operations.indexOf("images.edit")
  const generationIndex = parsed.operations.indexOf("images.generate")
  if (editIndex !== -1 && generationIndex === -1) {
    throw new UsageError(
      "images.edit requires images.generate in the same run for its safe fixture",
    )
  }
  if (editIndex !== -1 && generationIndex > editIndex) {
    throw new UsageError("images.generate must appear before images.edit")
  }
  if (imageCredits === 0) return
  if (!parsed.allowImageSpend) {
    throw new UsageError("Image operations require --allow-image-spend")
  }
  if (parsed.maxPlannedImageCredits === undefined) {
    throw new UsageError("Image operations require --max-planned-image-credits")
  }
  if (parsed.maxPlannedImageCredits < imageCredits) {
    throw new UsageError(
      `Planned image estimate is ${imageCredits} credits, above the acknowledged ${parsed.maxPlannedImageCredits}`,
    )
  }
  if (!parsed.outDir) throw new UsageError("Image operations require --out-dir")
}

function resolveTarget(
  parsed: ParsedFlags,
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): URL {
  const fromFlag =
    parsed.baseUrlValue === undefined ?
      undefined
    : normalizeBaseUrl(
        parsed.baseUrlValue,
        parsed.allowRemote,
        parsed.allowInsecureHttp,
      )
  const envValue = env.MAXIMAL_BASE_URL?.trim()
  const fromEnv =
    !envValue ? undefined : (
      normalizeBaseUrl(envValue, parsed.allowRemote, parsed.allowInsecureHttp)
    )
  if (fromFlag && fromEnv && fromFlag.origin !== fromEnv.origin) {
    throw new UsageError(
      "Ambiguous target: --base-url and MAXIMAL_BASE_URL differ",
    )
  }
  if (fromFlag) return fromFlag
  if (fromEnv) return fromEnv

  let running: ReturnType<typeof discoverRunningAppDev>
  try {
    running = discoverRunningAppDev(env, repoRoot)
  } catch (error) {
    const reason = error instanceof Error ? error.message : "discovery failed"
    throw new UsageError(`Could not discover app:dev: ${reason}`)
  }
  if (!running) {
    throw new UsageError(
      "No running app:dev instance was found for this worktree profile. Start bun run app:dev, set the same COPILOT_API_HOME used to launch it, or pass --base-url.",
    )
  }
  return running.baseUrl
}

export function parseArgs(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
  repoRoot = REPO_ROOT,
): SmokeOptions {
  const parsed = parseFlags(argv)
  validateFlags(parsed)
  return {
    baseUrl: resolveTarget(parsed, env, repoRoot),
    operations: parsed.operations,
    confirmLive: parsed.confirmLive,
    allowImageSpend: parsed.allowImageSpend,
    ...(parsed.maxPlannedImageCredits === undefined ?
      {}
    : { maxPlannedImageCredits: parsed.maxPlannedImageCredits }),
    ...(parsed.outDir === undefined ? {} : { outDir: parsed.outDir }),
    negativeProbes: parsed.negativeProbes,
    ...(env.MAXIMAL_API_KEY ? { apiKey: env.MAXIMAL_API_KEY } : {}),
  }
}
