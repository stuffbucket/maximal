/**
 * Claude Code's install hint, and Maximal's own install of it on Windows.
 *
 * Official routes (code.claude.com/docs/en/setup): the native installer
 * (`curl -fsSL https://claude.ai/install.sh | bash` on macOS, Linux and WSL;
 * `irm https://claude.ai/install.ps1 | iex` in PowerShell; `install.cmd` in
 * CMD), WinGet (`winget install Anthropic.ClaudeCode`), Homebrew, npm, and the
 * Linux package repositories.
 *
 * macOS and Linux only show the command to copy. On Windows Maximal can also
 * run WinGet for the user, after an explicit click. It doesn't run the
 * PowerShell installer itself: that runs a script fetched at install time, and
 * Maximal has no pinned hash for it. WinGet's Claude Code package is a
 * portable binary whose SHA-256 is pinned in Microsoft's reviewed manifest,
 * and WinGet refuses a mismatch. Maximal starts `winget` with an argument
 * vector (no shell), never asks for elevation, and never passes
 * `--ignore-security-hash` or `--accept-package-agreements`. The package has
 * no agreements to accept; if WinGet ever needs one, the install stops and
 * says so instead of accepting it on the user's behalf.
 */
import type {
  AppInstallHint,
  ClaudeCodeInstallStatus,
} from "~/lib/config/settings-types"
import type { StreamRunOptions, StreamRunResult } from "~/lib/system/run-file"

import { runFile, runFileStreaming } from "~/lib/system/run-file"

import { type ClaudeInstall, detectClaudeInstalls } from "./detect"

export const CLAUDE_CODE_POSIX_INSTALL_COMMAND =
  "curl -fsSL https://claude.ai/install.sh | sh"
export const CLAUDE_CODE_POWERSHELL_INSTALL_COMMAND =
  "irm https://claude.ai/install.ps1 | iex"

/** The WinGet package for Claude Code (manifests/a/Anthropic/ClaudeCode). */
export const CLAUDE_CODE_WINGET_ID = "Anthropic.ClaudeCode"
export const WINGET_INSTALL_ARGS: ReadonlyArray<string> = [
  "install",
  "--id",
  CLAUDE_CODE_WINGET_ID,
  "--exact",
  "--source",
  "winget",
  "--silent",
  "--disable-interactivity",
]

const WINGET_EXECUTABLE = "winget"
// Keep the optional capability probe below the Settings client's 5s timeout.
const WINGET_PROBE_TIMEOUT_MS = 3_000
/** A portable download of the Claude Code binary, on a slow link. */
const WINGET_INSTALL_TIMEOUT_MS = 15 * 60_000
/** A miss is retried after this long, so installing App Installer mid-session
 *  is noticed without a restart. A found WinGet is remembered. */
const WINGET_MISS_TTL_MS = 60_000
const OUTPUT_LINES = 12
const OUTPUT_LINE_CHARS = 300

export type WingetProbe = () => Promise<boolean>

/** Whether `winget` runs. Concurrent callers share one probe. */
export function createWingetProbe(
  run: typeof runFile = runFile,
  now: () => number = Date.now,
): WingetProbe {
  let found = false
  let missedAt: number | null = null
  let inFlight: Promise<boolean> | null = null
  return () => {
    if (found) return Promise.resolve(true)
    if (missedAt !== null && now() - missedAt < WINGET_MISS_TTL_MS) {
      return Promise.resolve(false)
    }
    if (!inFlight) {
      inFlight = run(WINGET_EXECUTABLE, ["--version"], {
        timeoutMs: WINGET_PROBE_TIMEOUT_MS,
      })
        .then((result) => {
          if (result.code === 0) found = true
          else missedAt = now()
          return result.code === 0
        })
        .finally(() => {
          inFlight = null
        })
    }
    return inFlight
  }
}

export const wingetAvailable: WingetProbe = createWingetProbe()

/** The install hint Settings shows when no Claude Code is installed. macOS and
 *  Linux keep the command they always had; Windows gets the PowerShell
 *  installer and, when WinGet runs, the one-click WinGet install. */
export async function claudeCodeInstallHint(
  platform: NodeJS.Platform = process.platform,
  probe: WingetProbe = wingetAvailable,
): Promise<AppInstallHint> {
  if (platform !== "win32") {
    return {
      method: "curl",
      command: CLAUDE_CODE_POSIX_INSTALL_COMMAND,
      automatic: null,
    }
  }
  return {
    method: "powershell",
    command: CLAUDE_CODE_POWERSHELL_INSTALL_COMMAND,
    automatic: (await probe()) ? "winget" : null,
  }
}

/** A CSI escape sequence: ESC [, parameters, then one letter (colours, cursor). */
const ANSI_ESCAPE = new RegExp(
  String.fromCodePoint(27) + String.raw`\[[\d;?]*[A-Za-z]`,
  "gu",
)
/** The block glyphs WinGet draws its progress bar with. */
const PROGRESS_BLOCKS = /[▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▔▕▖▗▘▙▚▛▜▝▞▟]/gu
const SPINNER_ONLY = /^[-\\|/]+$/u

/**
 * What a line of WinGet output shows: the text after its last carriage return
 * (WinGet redraws progress in place), with escape sequences, control
 * characters and progress-bar blocks removed. Null when nothing is left worth
 * showing, such as a blank line or a spinner frame.
 */
export function visibleLine(raw: string): string | null {
  const redrawn = (raw.split("\r").at(-1) ?? "").replaceAll(ANSI_ESCAPE, "")
  let kept = ""
  for (const ch of redrawn) {
    const code = ch.codePointAt(0) ?? 0
    if ((code < 32 && code !== 9) || code === 127) continue
    kept += ch
  }
  const text = kept
    .replaceAll(PROGRESS_BLOCKS, "")
    .replaceAll(/\s+/gu, " ")
    .trim()
  if (text === "" || SPINNER_ONLY.test(text)) return null
  return text.length > OUTPUT_LINE_CHARS ?
      `${text.slice(0, OUTPUT_LINE_CHARS - 1)}…`
    : text
}

export type ClaudeCodeInstallRefusal =
  | "running"
  | "not-windows"
  | "already-installed"
  | "winget-missing"

/** HTTP-facing copy for a refused start. `running` is not an error: the
 *  caller gets the install already going. */
export const CLAUDE_CODE_INSTALL_REFUSAL_MESSAGE: Record<
  Exclude<ClaudeCodeInstallRefusal, "running">,
  string
> = {
  "not-windows":
    "Automatic install is only offered on Windows. Run the install command instead.",
  "already-installed": "Claude Code is already installed.",
  "winget-missing":
    "WinGet isn't available on this PC. Run the PowerShell install command instead.",
}

export type ClaudeCodeInstallStart =
  | { started: true; status: ClaudeCodeInstallStatus }
  | {
      started: false
      refusal: ClaudeCodeInstallRefusal
      status: ClaudeCodeInstallStatus
    }

export type StreamingRunner = (
  file: string,
  args: Array<string>,
  options: StreamRunOptions,
) => Promise<StreamRunResult>

export interface ClaudeCodeInstallerDeps {
  run?: StreamingRunner
  detect?: () => Promise<Array<ClaudeInstall>>
  wingetAvailable?: WingetProbe
  platform?: NodeJS.Platform
  timeoutMs?: number
}

type InstallState = ClaudeCodeInstallStatus["state"]

/**
 * Runs WinGet's Claude Code install in the background, one at a time. The
 * result is judged by detection afterwards, not by WinGet's exit code alone:
 * a WinGet that reports nothing to upgrade while Claude Code is present still
 * counts as installed.
 */
export class ClaudeCodeInstaller {
  readonly #run: StreamingRunner
  readonly #detect: () => Promise<Array<ClaudeInstall>>
  readonly #wingetAvailable: WingetProbe
  readonly #platform: NodeJS.Platform
  readonly #timeoutMs: number
  #state: InstallState = "idle"
  #reason: ClaudeCodeInstallStatus["reason"] = null
  #exitCode: number | null = null
  #lines: Array<string> = []
  /** The unfinished line; WinGet redraws progress without a newline. */
  #partial = ""

  constructor(deps: ClaudeCodeInstallerDeps = {}) {
    this.#run = deps.run ?? runFileStreaming
    this.#detect = deps.detect ?? (() => detectClaudeInstalls())
    this.#wingetAvailable = deps.wingetAvailable ?? wingetAvailable
    this.#platform = deps.platform ?? process.platform
    this.#timeoutMs = deps.timeoutMs ?? WINGET_INSTALL_TIMEOUT_MS
  }

  status(): ClaudeCodeInstallStatus {
    const tail = visibleLine(this.#partial)
    return {
      state: this.#state,
      output: tail === null ? [...this.#lines] : [...this.#lines, tail],
      reason: this.#reason,
      exitCode: this.#exitCode,
    }
  }

  /** Begin the install if it is allowed. Resolves once it has begun, or was
   *  refused; the install itself carries on in the background. */
  async start(): Promise<ClaudeCodeInstallStart> {
    if (this.#busy()) return this.#refuse("running")
    if (this.#platform !== "win32") return this.#refuse("not-windows")
    if ((await this.#detect()).length > 0)
      return this.#refuse("already-installed")
    if (!(await this.#wingetAvailable())) return this.#refuse("winget-missing")
    // Another request may have begun while the checks above were awaited.
    if (!this.#begin()) return this.#refuse("running")
    void this.#execute()
    return { started: true, status: this.status() }
  }

  #busy(): boolean {
    return this.#state === "running"
  }

  #refuse(refusal: ClaudeCodeInstallRefusal): ClaudeCodeInstallStart {
    return { started: false, refusal, status: this.status() }
  }

  #begin(): boolean {
    if (this.#busy()) return false
    this.#state = "running"
    this.#reason = null
    this.#exitCode = null
    this.#lines = []
    this.#partial = ""
    return true
  }

  #settle(
    state: "succeeded" | "failed",
    reason: ClaudeCodeInstallStatus["reason"],
    exitCode: number | null,
  ): void {
    this.#flush()
    this.#state = state
    this.#reason = reason
    this.#exitCode = exitCode
  }

  async #execute(): Promise<void> {
    try {
      const result = await this.#run(
        WINGET_EXECUTABLE,
        [...WINGET_INSTALL_ARGS],
        {
          timeoutMs: this.#timeoutMs,
          onOutput: (chunk) => this.#absorb(chunk),
        },
      )
      const installed = (await this.#detect()).length > 0
      if (installed) {
        this.#settle("succeeded", null, result.code)
      } else if (result.timedOut) {
        this.#settle("failed", "timed-out", null)
      } else if (result.notFound) {
        this.#settle("failed", "winget-missing", null)
      } else if (result.code !== 0) {
        this.#settle("failed", "exit-code", result.code)
      } else {
        this.#settle("failed", "not-found-after-install", 0)
      }
    } catch {
      this.#settle("failed", "error", null)
    }
  }

  #absorb(chunk: string): void {
    // WinGet redraws progress with bare carriage returns. Commit each frame so
    // both the retained lines and the unfinished tail stay bounded.
    const pieces = (this.#partial + chunk).split(/\r\n|[\r\n]/u)
    this.#partial = pieces.pop() ?? ""
    for (const piece of pieces) this.#commit(piece)
  }

  #flush(): void {
    this.#commit(this.#partial)
    this.#partial = ""
  }

  #commit(raw: string): void {
    const text = visibleLine(raw)
    if (text === null) return
    this.#lines.push(text)
    if (this.#lines.length > OUTPUT_LINES) {
      this.#lines.splice(0, this.#lines.length - OUTPUT_LINES)
    }
  }
}

/** The one install Settings can start. Process-local: a restart forgets it,
 *  and detection decides whether Claude Code is there. */
export const claudeCodeInstaller = new ClaudeCodeInstaller()
