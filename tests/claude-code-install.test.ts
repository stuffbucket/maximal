import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ClaudeInstall } from "~/apps/claude-code/detect"

import {
  detectClaudeInstalls,
  resolveLocalAppDataDir,
  wingetLinksDir,
} from "~/apps/claude-code/detect"
import {
  CLAUDE_CODE_POSIX_INSTALL_COMMAND,
  CLAUDE_CODE_POWERSHELL_INSTALL_COMMAND,
  ClaudeCodeInstaller,
  claudeCodeInstallHint,
  createWingetProbe,
  visibleLine,
  WINGET_INSTALL_ARGS,
  type StreamingRunner,
} from "~/apps/claude-code/install"
import { runFileStreaming, type StreamRunResult } from "~/lib/system/run-file"

const FOUND: ClaudeInstall = {
  path: "C:/Users/me/AppData/Local/Microsoft/WinGet/Links/claude.exe",
  resolvedPath:
    "C:/Users/me/AppData/Local/Microsoft/WinGet/Packages/claude.exe",
  version: "2.1.302",
  source: "winget",
}

const none = (): Promise<Array<ClaudeInstall>> => Promise.resolve([])
const found = (): Promise<Array<ClaudeInstall>> => Promise.resolve([FOUND])
const yes = (): Promise<boolean> => Promise.resolve(true)
const no = (): Promise<boolean> => Promise.resolve(false)

/** A runner the test finishes by hand, recording what it was asked to run. */
function controlledRunner() {
  const calls: Array<{ file: string; args: Array<string> }> = []
  let onOutput: ((chunk: string) => void) | undefined
  let finishRun: ((result: StreamRunResult) => void) | undefined
  const run: StreamingRunner = (file, args, options) => {
    calls.push({ file, args: [...args] })
    onOutput = options.onOutput
    return new Promise((resolve) => {
      finishRun = resolve
    })
  }
  return {
    run,
    calls,
    emit: (chunk: string) => onOutput?.(chunk),
    finish: (result: Partial<StreamRunResult> = {}) =>
      finishRun?.({
        stdout: "",
        stderr: "",
        code: 0,
        notFound: false,
        timedOut: false,
        ...result,
      }),
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("claude-code install hint", () => {
  test("macOS and Linux keep the curl command, with no one-click install", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const hint = await claudeCodeInstallHint(platform, yes)
      expect(hint).toEqual({
        method: "curl",
        command: CLAUDE_CODE_POSIX_INSTALL_COMMAND,
        automatic: null,
      })
    }
  })

  test("Windows shows the PowerShell installer and offers WinGet when it runs", async () => {
    const hint = await claudeCodeInstallHint("win32", yes)
    expect(hint).toEqual({
      method: "powershell",
      command: CLAUDE_CODE_POWERSHELL_INSTALL_COMMAND,
      automatic: "winget",
    })
    expect(CLAUDE_CODE_POWERSHELL_INSTALL_COMMAND).toBe(
      "irm https://claude.ai/install.ps1 | iex",
    )
  })

  test("Windows without WinGet keeps the command and offers no button", async () => {
    const hint = await claudeCodeInstallHint("win32", no)
    expect(hint.automatic).toBeNull()
    expect(hint.command).toBe(CLAUDE_CODE_POWERSHELL_INSTALL_COMMAND)
  })
})

describe("WinGet install command", () => {
  test("is an argument vector for the official package, with no escalation or hash bypass", () => {
    expect([...WINGET_INSTALL_ARGS]).toEqual([
      "install",
      "--id",
      "Anthropic.ClaudeCode",
      "--exact",
      "--source",
      "winget",
      "--silent",
      "--disable-interactivity",
    ])
    for (const forbidden of [
      "--ignore-security-hash",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--scope",
      "--override",
      "--custom",
    ]) {
      expect(WINGET_INSTALL_ARGS).not.toContain(forbidden)
    }
  })
})

describe("winget probe", () => {
  test("a found WinGet is remembered; a miss is retried after a minute", async () => {
    let now = 0
    const replies: Array<number> = [127, 0]
    const calls: Array<{ command: string; timeoutMs: number }> = []
    const probe = createWingetProbe(
      (file, args, options) => {
        calls.push({
          command: `${file} ${args.join(" ")}`,
          timeoutMs: options.timeoutMs,
        })
        return Promise.resolve({
          stdout: "",
          stderr: "",
          code: replies.shift() ?? 0,
          notFound: true,
        })
      },
      () => now,
    )
    expect(await probe()).toBe(false)
    expect(await probe()).toBe(false)
    expect(calls).toEqual([{ command: "winget --version", timeoutMs: 3_000 }])
    expect(calls[0]?.timeoutMs).toBeLessThan(5_000)
    now = 60_000
    expect(await probe()).toBe(true)
    expect(await probe()).toBe(true)
    expect(calls).toHaveLength(2)
  })
})

describe("ClaudeCodeInstaller", () => {
  test("refuses outside Windows and never runs WinGet", async () => {
    const ctl = controlledRunner()
    const installer = new ClaudeCodeInstaller({
      run: ctl.run,
      detect: none,
      wingetAvailable: yes,
      platform: "darwin",
    })
    const result = await installer.start()
    expect(result).toMatchObject({ started: false, refusal: "not-windows" })
    expect(ctl.calls).toEqual([])
  })

  test("refuses when Claude Code is already installed", async () => {
    const ctl = controlledRunner()
    const installer = new ClaudeCodeInstaller({
      run: ctl.run,
      detect: found,
      wingetAvailable: yes,
      platform: "win32",
    })
    expect(await installer.start()).toMatchObject({
      started: false,
      refusal: "already-installed",
    })
    expect(ctl.calls).toEqual([])
  })

  test("refuses when WinGet isn't available", async () => {
    const ctl = controlledRunner()
    const installer = new ClaudeCodeInstaller({
      run: ctl.run,
      detect: none,
      wingetAvailable: no,
      platform: "win32",
    })
    expect(await installer.start()).toMatchObject({
      started: false,
      refusal: "winget-missing",
    })
    expect(ctl.calls).toEqual([])
  })

  test("runs WinGet with an argument vector, streams progress, and re-detects", async () => {
    const ctl = controlledRunner()
    let installed: Array<ClaudeInstall> = []
    const installer = new ClaudeCodeInstaller({
      run: ctl.run,
      detect: () => Promise.resolve(installed),
      wingetAvailable: yes,
      platform: "win32",
    })
    const started = await installer.start()
    expect(started.started).toBe(true)
    expect(ctl.calls).toEqual([
      { file: "winget", args: [...WINGET_INSTALL_ARGS] },
    ])

    ctl.emit("Found Claude Code [Anthropic.ClaudeCode]\r\n")
    ctl.emit("  ███ 10.0 MB / 50.0 MB\r  ████ 40.0 MB / 50.0 MB")
    expect(installer.status()).toMatchObject({
      state: "running",
      output: [
        "Found Claude Code [Anthropic.ClaudeCode]",
        "10.0 MB / 50.0 MB",
        "40.0 MB / 50.0 MB",
      ],
    })

    installed = [FOUND]
    ctl.finish({ code: 0 })
    await settle()
    expect(installer.status()).toMatchObject({
      state: "succeeded",
      reason: null,
      exitCode: 0,
    })
  })

  test("bare-carriage-return progress remains bounded to the output tail", async () => {
    const ctl = controlledRunner()
    const installer = new ClaudeCodeInstaller({
      run: ctl.run,
      detect: none,
      wingetAvailable: yes,
      platform: "win32",
    })
    await installer.start()
    ctl.emit(Array.from({ length: 100 }, (_, i) => `${i}%\r`).join(""))

    const output = installer.status().output
    expect(output).toHaveLength(12)
    expect(output.at(-1)).toBe("99%")

    ctl.finish({ code: 1 })
    await settle()
  })

  test("a second start while one runs is refused and runs nothing new", async () => {
    const ctl = controlledRunner()
    const installer = new ClaudeCodeInstaller({
      run: ctl.run,
      detect: none,
      wingetAvailable: yes,
      platform: "win32",
    })
    await installer.start()
    const second = await installer.start()
    expect(second).toMatchObject({ started: false, refusal: "running" })
    expect(ctl.calls).toHaveLength(1)
    ctl.finish({ code: 1 })
    await settle()
  })

  test.each([
    {
      name: "a non-zero exit",
      result: { code: 1 },
      reason: "exit-code",
      exitCode: 1,
    },
    {
      name: "a zero exit with nothing installed",
      result: { code: 0 },
      reason: "not-found-after-install",
      exitCode: 0,
    },
    {
      name: "a timeout",
      result: { timedOut: true, code: 1 },
      reason: "timed-out",
      exitCode: null,
    },
    {
      name: "WinGet missing at spawn",
      result: { notFound: true, code: 127 },
      reason: "winget-missing",
      exitCode: null,
    },
  ])(
    "a finished install that didn't add Claude Code fails: $name",
    async (row) => {
      const ctl = controlledRunner()
      const installer = new ClaudeCodeInstaller({
        run: ctl.run,
        detect: none,
        wingetAvailable: yes,
        platform: "win32",
      })
      await installer.start()
      ctl.finish(row.result)
      await settle()
      expect(installer.status()).toMatchObject({
        state: "failed",
        reason: row.reason,
        exitCode: row.exitCode,
      })
    },
  )

  test("WinGet reporting an error still counts as installed when Claude Code is there", async () => {
    const ctl = controlledRunner()
    let installed: Array<ClaudeInstall> = []
    const installer = new ClaudeCodeInstaller({
      run: ctl.run,
      detect: () => Promise.resolve(installed),
      wingetAvailable: yes,
      platform: "win32",
    })
    await installer.start()
    installed = [FOUND]
    ctl.finish({ code: -1978335189 })
    await settle()
    expect(installer.status()).toMatchObject({ state: "succeeded" })
  })

  test("an unexpected failure is reported as an error, and a retry can start", async () => {
    let attempts = 0
    const installer = new ClaudeCodeInstaller({
      run: () => {
        attempts += 1
        return Promise.reject(new Error("spawn exploded"))
      },
      detect: none,
      wingetAvailable: yes,
      platform: "win32",
    })
    await installer.start()
    await settle()
    expect(installer.status()).toMatchObject({
      state: "failed",
      reason: "error",
    })
    expect(await installer.start()).toMatchObject({ started: true })
    await settle()
    expect(attempts).toBe(2)
  })
})

describe("visibleLine", () => {
  test("blank lines and spinner frames show nothing", () => {
    expect(visibleLine("")).toBeNull()
    expect(visibleLine("   \r  ")).toBeNull()
    expect(visibleLine(String.raw`-\|/`)).toBeNull()
  })

  test("a redrawn line shows its last state", () => {
    expect(visibleLine("10%\r20%\rDone")).toBe("Done")
    expect(visibleLine("  ████████  10.0 MB / 50.0 MB")).toBe(
      "10.0 MB / 50.0 MB",
    )
  })

  test("escape sequences and control characters are removed", () => {
    expect(visibleLine("\u001b[31mred\u001b[0m text\u0007")).toBe("red text")
  })

  test("long lines are shortened", () => {
    const text = visibleLine("x".repeat(400))
    expect(text?.length).toBe(300)
    expect(text?.endsWith("…")).toBe(true)
  })
})

describe("runFileStreaming", () => {
  test("hands output over while the child runs, and reports its exit", async () => {
    const chunks: Array<string> = []
    const result = await runFileStreaming(
      process.execPath,
      [
        "-e",
        String.raw`process.stdout.write('out\n'); process.stderr.write('err\n')`,
      ],
      { timeoutMs: 20_000, onOutput: (chunk) => chunks.push(chunk) },
    )
    expect(result).toMatchObject({ code: 0, notFound: false, timedOut: false })
    expect(result.stdout).toBe("out\n")
    expect(chunks.join("")).toContain("out")
    expect(chunks.join("")).toContain("err")
  })

  test("a missing program is reported as not found", async () => {
    const result = await runFileStreaming(
      path.join(os.tmpdir(), "maximal-no-such-program-xyz"),
      [],
      { timeoutMs: 5_000 },
    )
    expect(result).toMatchObject({ code: 127, notFound: true })
  })

  test("a child past its timeout is stopped and reported as timed out", async () => {
    const result = await runFileStreaming(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)"],
      { timeoutMs: 300 },
    )
    expect(result.timedOut).toBe(true)
    expect(result.code).not.toBe(0)
  })

  test("a child that ignores the soft timeout still settles after the kill grace", async () => {
    if (process.platform === "win32") return
    const startedAt = Date.now()
    const result = await runFileStreaming(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"],
      { timeoutMs: 300 },
    )
    const elapsedMs = Date.now() - startedAt
    expect(result.timedOut).toBe(true)
    expect(elapsedMs).toBeGreaterThanOrEqual(1_200)
    expect(elapsedMs).toBeLessThan(2_500)
  })
})

describe("WinGet links folder detection", () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-winget-links-"))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("finds claude.exe there even though a running Maximal's PATH doesn't list it", async () => {
    const localAppData = path.join(root, "LocalAppData")
    const link = path.join(wingetLinksDir(localAppData), "claude.exe")
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.writeFileSync(link, "not really a binary")
    const installs = await detectClaudeInstalls({
      homeDir: path.join(root, "home"),
      pathDirs: [],
      npmPrefix: null,
      localAppData,
      platform: "win32",
      readVersion: () => "2.1.302",
    })
    expect(installs.find((i) => i.path === link)?.source).toBe("winget")
  })

  test("classifies a WinGet link already present on PATH as winget", async () => {
    const localAppData = path.join(root, "LocalAppData")
    const links = wingetLinksDir(localAppData)
    const link = path.join(links, "claude.exe")
    fs.mkdirSync(links, { recursive: true })
    fs.writeFileSync(link, "not really a binary")

    const installs = await detectClaudeInstalls({
      homeDir: path.join(root, "home"),
      pathDirs: [links],
      npmPrefix: null,
      localAppData,
      platform: "win32",
      readVersion: () => "2.1.302",
    })

    expect(installs).toHaveLength(1)
    expect(installs[0]).toMatchObject({ path: link, source: "winget" })
  })

  test("an injected home never resolves through the process user's LOCALAPPDATA", () => {
    const home = path.join(root, "isolated-home")
    const foreignLocalAppData = path.join(root, "foreign-local-app-data")

    expect(
      resolveLocalAppDataDir({
        home,
        homeOverridden: true,
        environmentLocalAppData: foreignLocalAppData,
      }),
    ).toBe(path.join(home, "AppData", "Local"))
  })
})
