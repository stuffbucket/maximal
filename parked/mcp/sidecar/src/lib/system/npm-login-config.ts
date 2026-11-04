/**
 * What npm itself says about the registry and global prefix, asked the way
 * the user's own terminal would.
 *
 * Maximal is launched from Finder or Explorer, so on macOS and Linux it does
 * not inherit the terminal's environment: an `NPM_CONFIG_REGISTRY` exported
 * from a shell profile is invisible to it, and the Work IQ install hint
 * would name a different registry than the pasted command uses. Asking npm
 * through the user's shell gets its own answer, whatever mix of env vars and
 * npmrc files produced it. The shell is login and interactive (`-lic`): a
 * registry exported from `~/.zshrc` (where most people put it) is only seen
 * by an interactive shell, and stdin is closed so nothing can wait on input.
 * (Windows GUI apps inherit user environment variables, so npm runs through
 * cmd.exe there.)
 *
 * Like `npmGlobalPrefix()` this is async and cached, filled at startup and
 * refreshed in the background; it never runs on a request path, and
 * synchronous detection reads `cachedNpmLoginConfig()`.
 */
import { type RunResult, npmGlobalPrefix, runFile } from "./run-file"

export interface NpmLoginConfig {
  /** `npm config get registry` */
  registry: string | null
  /** `npm config get @microsoft:registry` (the Work IQ package's scope) */
  scopeRegistry: string | null
  /** `npm prefix -g` */
  prefix: string | null
}

const NPM_LOGIN_TIMEOUT_MS = 4000
/** A found answer is re-asked at most this often, in the background. */
const REFRESH_MS = 10 * 60_000
/** An all-null answer (no npm, or a timeout) is retried sooner. */
const MISS_TTL_MS = 60_000

const NONE: NpmLoginConfig = {
  registry: null,
  scopeRegistry: null,
  prefix: null,
}

/** Fixed script: nothing the user controls is interpolated into it. */
const POSIX_SCRIPT =
  "npm config get registry; npm config get @microsoft:registry; npm prefix -g"

const WINDOWS_SCRIPT =
  "npm config get registry & npm config get @microsoft:registry & npm prefix -g"
/** npm on Windows is slow (often about a second per call); this runs in the
 *  background only. */
const WINDOWS_TIMEOUT_MS = 8000

/** npm prints the literal `undefined` for an unset key. */
function cleanLine(line: string | undefined): string | null {
  const value = line?.trim() ?? ""
  return value === "" || value === "undefined" ? null : value
}

/** The three answers, in order. A login shell may print a banner first, so
 *  the last three lines are the answers; fewer than three means npm didn't
 *  run (or was killed), and nothing is trusted. */
export function parseNpmLoginOutput(stdout: string): NpmLoginConfig {
  const lines = stdout.trim().split(/\r?\n/u)
  if (lines.length < 3) return NONE
  const [registry, scopeRegistry, prefix] = lines.slice(-3)
  return {
    registry: cleanLine(registry),
    scopeRegistry: cleanLine(scopeRegistry),
    prefix: cleanLine(prefix),
  }
}

interface Deps {
  run: typeof runFile
  now: () => number
  platform: NodeJS.Platform
  env: Readonly<Record<string, string | undefined>>
}

const defaultDeps = (): Deps => ({
  run: runFile,
  now: Date.now,
  platform: process.platform,
  env: process.env,
})

let deps: Deps = defaultDeps()
let cache: { value: NpmLoginConfig; atMs: number } | undefined
let inFlight: Promise<NpmLoginConfig> | undefined

function isMiss(value: NpmLoginConfig): boolean {
  return (
    value.registry === null
    && value.scopeRegistry === null
    && value.prefix === null
  )
}

const RUN_OPTIONS = { timeoutMs: NPM_LOGIN_TIMEOUT_MS, closeStdin: true }

async function askLoginShell(d: Deps): Promise<NpmLoginConfig> {
  const shells = [d.env.SHELL, d.platform === "darwin" ? "/bin/zsh" : undefined]
    .concat("/bin/sh")
    .filter(Boolean) as Array<string>
  for (const shell of new Set(shells)) {
    const result: RunResult = await d.run(
      shell,
      ["-lic", POSIX_SCRIPT],
      RUN_OPTIONS,
    )
    if (result.notFound) continue
    return parseNpmLoginOutput(result.stdout)
  }
  return NONE
}

/** Windows: npm is a `.cmd` shim, which Node refuses to spawn without a
 *  shell (CVE-2024-27980), so one fixed script runs through cmd.exe. */
async function askCmd(d: Deps): Promise<NpmLoginConfig> {
  const result = await d.run(
    d.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", WINDOWS_SCRIPT],
    { timeoutMs: WINDOWS_TIMEOUT_MS, closeStdin: true },
  )
  return parseNpmLoginOutput(result.stdout)
}

function lookup(): Promise<NpmLoginConfig> {
  const d = deps
  const asked = d.platform === "win32" ? askCmd(d) : askLoginShell(d)
  // A lookup orphaned by a test reset must not write into the fresh cache.
  const started: Promise<NpmLoginConfig> = asked
    .catch(() => NONE)
    .then((value) => {
      if (inFlight === started) cache = { value, atMs: d.now() }
      return value
    })
    .finally(() => {
      if (inFlight === started) inFlight = undefined
    })
  inFlight = started
  return started
}

/**
 * The registry and prefix npm reports for the user's login environment.
 * Concurrent callers share one lookup. Once there is an answer, callers get
 * it at once; when it is older than ten minutes (a minute for an all-null
 * answer) a refresh runs in the background.
 */
export function npmLoginConfig(): Promise<NpmLoginConfig> {
  if (cache) {
    const age = deps.now() - cache.atMs
    const ttl = isMiss(cache.value) ? MISS_TTL_MS : REFRESH_MS
    if (age >= ttl && !inFlight) void lookup()
    return Promise.resolve(cache.value)
  }
  return inFlight ?? lookup()
}

/** The last answer for synchronous callers: undefined until
 *  `npmLoginConfig()` has resolved once. Never spawns. */
export function cachedNpmLoginConfig(): NpmLoginConfig | undefined {
  return cache?.value
}

/** Fill every npm answer detection reads (this lookup and the plain prefix
 *  fallback) before synchronous detection runs. */
export async function warmNpmDetection(): Promise<void> {
  await Promise.all([npmLoginConfig(), npmGlobalPrefix()])
}

export function __setNpmLoginDepsForTests(o: Partial<Deps>): void {
  deps = { ...deps, ...o }
}

export function __resetNpmLoginForTests(): void {
  deps = defaultDeps()
  cache = undefined
  inFlight = undefined
}
