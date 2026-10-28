/**
 * Run a program without stopping the proxy while it runs.
 *
 * The proxy is one process with one event loop: a synchronous spawn
 * (`execFileSync` and friends) holds every in-flight request, streaming
 * responses included, until the child exits. Anything a request handler or a
 * background task runs goes through here instead; the lint rule in
 * eslint.config.js keeps the synchronous forms out of `src/` (see
 * docs/architecture.md → Never block the event loop).
 */
import { type ExecFileException, execFile } from "node:child_process"

export interface RunResult {
  stdout: string
  stderr: string
  /** Exit code; 1 when the child was killed (e.g. it hit the timeout). */
  code: number
  /** True when the program wasn't found (ENOENT). */
  notFound: boolean
}

export interface RunOptions {
  timeoutMs: number
  maxBuffer?: number
}

/** Run `file` with `args` (no shell). Never rejects: a failure to start or a
 *  non-zero exit is reported in the result. */
export function runFile(
  file: string,
  args: Array<string>,
  options: RunOptions,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer ?? 1_000_000,
        windowsHide: true,
      },
      (error: ExecFileException | null, stdout, stderr) => {
        if (error?.code === "ENOENT") {
          resolve({ stdout: "", stderr: "", code: 127, notFound: true })
          return
        }
        let code = 0
        if (error) {
          code = typeof error.code === "number" ? error.code : 1
        }
        resolve({ stdout, stderr, code, notFound: false })
      },
    )
  })
}

// ── npm's global prefix ────────────────────────────────────────────────

const NPM_TIMEOUT_MS = 5000
/** A miss is retried after this long, so installing Node mid-session is
 *  noticed; a found prefix doesn't change while Maximal runs. */
const NPM_MISS_TTL_MS = 60_000

type NpmPrefixRunner = () => Promise<RunResult>

let npmRunner: NpmPrefixRunner = () =>
  runFile("npm", ["prefix", "-g"], { timeoutMs: NPM_TIMEOUT_MS })
let nowMs: () => number = Date.now
let npmCache: { prefix: string | null; atMs: number } | undefined
let npmInFlight: Promise<string | null> | undefined

/**
 * `npm prefix -g`, or null when npm isn't available. Spawning npm is the
 * slowest detection probe and Settings lists run detection on every load, so
 * concurrent callers share one spawn and the answer is cached.
 */
export function npmGlobalPrefix(): Promise<string | null> {
  if (
    npmCache
    && (npmCache.prefix !== null || nowMs() - npmCache.atMs < NPM_MISS_TTL_MS)
  ) {
    return Promise.resolve(npmCache.prefix)
  }
  if (npmInFlight) return npmInFlight
  // A lookup orphaned by __resetNpmPrefixForTests must not write its result
  // into the fresh cache, or a real npm prefix lands in a later test.
  const lookup: Promise<string | null> = npmRunner()
    .then((result) => {
      const out = result.code === 0 ? result.stdout.trim() : ""
      return out.length > 0 ? out : null
    })
    .then((prefix) => {
      if (npmInFlight === lookup) npmCache = { prefix, atMs: nowMs() }
      return prefix
    })
    .finally(() => {
      if (npmInFlight === lookup) npmInFlight = undefined
    })
  npmInFlight = lookup
  return lookup
}

/** The cached `npm prefix -g` for synchronous callers: undefined until
 *  `npmGlobalPrefix()` has resolved once. Never spawns. */
export function cachedNpmGlobalPrefix(): string | null | undefined {
  return npmCache?.prefix
}

export function __setNpmPrefixDepsForTests(o: {
  run?: NpmPrefixRunner
  now?: () => number
}): void {
  if (o.run) npmRunner = o.run
  if (o.now) nowMs = o.now
}

export function __resetNpmPrefixForTests(): void {
  npmRunner = () =>
    runFile("npm", ["prefix", "-g"], { timeoutMs: NPM_TIMEOUT_MS })
  nowMs = Date.now
  npmCache = undefined
  npmInFlight = undefined
}
