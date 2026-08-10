import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _electron as electron, type ElectronApplication } from '@playwright/test'

import { relocatePackagedApp } from './relocate-app'

export interface RunningApp {
  app: ElectronApplication
  /** Every line seen on the app's own stdout+stderr so far (the packaged
   *  app's main-process output — includes its `[maximal-client]`/`[core]`
   *  narration — not the renderer's DevTools console). Appended to live. */
  lines: string[]
  /** Root temp dir holding the relocated app copy; remove on teardown. */
  appRoot: string
  userDataDir: string
}

/**
 * Launch a freshly relocated copy of the packaged app (see
 * ./relocate-app.ts) via Playwright's Electron support, pointed at an
 * isolated `--user-data-dir` so it never touches a real user profile or
 * collides with a dev instance already running on this machine.
 */
export async function launchPackagedApp(): Promise<RunningApp> {
  const { appPath, root: appRoot } = relocatePackagedApp()
  const userDataDir = mkdtempSync(join(tmpdir(), 'maximal-e2e-userdata-'))
  const executablePath = join(appPath, 'Contents/MacOS/Maximal')

  const lines: string[] = []
  const recordLines = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) lines.push(line)
  }

  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDir}`],
  })
  const proc = app.process()
  proc.stdout?.on('data', recordLines)
  proc.stderr?.on('data', recordLines)

  return { app, lines, appRoot, userDataDir }
}

export function cleanupPackagedApp(running: RunningApp): void {
  rmSync(running.appRoot, { recursive: true, force: true })
  rmSync(running.userDataDir, { recursive: true, force: true })
}

/**
 * Poll `lines` for a pattern. The app's stdout streams in asynchronously —
 * by the time a caller looks, the match may already be buffered, or it may
 * not have arrived yet, so this checks both the backlog and new arrivals.
 */
export async function waitForLine(lines: string[], pattern: RegExp, timeoutMs = 20_000): Promise<string> {
  const start = Date.now()
  for (;;) {
    const found = lines.find((line) => pattern.test(line))
    if (found !== undefined) return found
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for a line matching ${pattern}.\nSeen so far:\n${lines.join('\n')}`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}
