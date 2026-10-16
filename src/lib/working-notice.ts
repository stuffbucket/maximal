/**
 * "Maximal is working": a one-time OS notification the first time tokens go
 * through — once for a brand-new install (no usage history at all), and once
 * per app the first time tokens go through after its integration is turned
 * on. Turning an integration off re-arms it for that app. Remembered across
 * restarts in notices.json; the CLI (a separate process) writes it too, so
 * it's read fresh rather than cached.
 *
 * Traffic isn't attributed to an app: any tokens after an app is armed
 * count. The point is only to tell the user things work. The sidecar
 * decides and remembers; the menu-bar shell polls `takeWorkingNotice()`
 * (POST /settings/api/notices/working) and shows the notification.
 *
 * Best-effort throughout: a missing or unwritable file never affects
 * request handling.
 */
import fs from "node:fs"
import path from "node:path"

import { PATHS } from "~/lib/platform/paths"
import { hasAnyTokenUsage, onTokenUsageRecorded } from "~/lib/token-usage"

const FIRST_USE = "first-use"

interface NoticeFile {
  /** Waiting for the first tokens. `name` is what the notification says. */
  armed: Array<{ id: string; name: string }>
  /** Already told; stays quiet until reset by turning the integration off. */
  confirmed: Array<string>
}

/** A notice waiting for the shell to show: which apps to name (may be none). */
export interface WorkingNotice {
  apps: Array<string>
}

let pending: WorkingNotice | null = null

function noticePath(): string {
  return path.join(PATHS.APP_DIR, "notices.json")
}

function read(): NoticeFile {
  try {
    const parsed = JSON.parse(
      // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse's type only accepts string
      fs.readFileSync(noticePath(), "utf8"),
    ) as Partial<NoticeFile>
    return {
      armed: Array.isArray(parsed.armed) ? parsed.armed : [],
      confirmed: Array.isArray(parsed.confirmed) ? parsed.confirmed : [],
    }
  } catch {
    return { armed: [], confirmed: [] }
  }
}

function write(file: NoticeFile): void {
  try {
    fs.writeFileSync(noticePath(), `${JSON.stringify(file, null, 2)}\n`)
  } catch {
    // Best-effort: worst case the user gets the notice again, or not at all.
  }
}

/** An integration was turned on: tell the user on the next tokens, once. */
export function armWorkingNotice(id: string, name: string): void {
  const file = read()
  if (file.confirmed.includes(id) || file.armed.some((a) => a.id === id)) return
  file.armed.push({ id, name })
  write(file)
}

/** An integration was turned off: forget we told them, so turning it back on
 *  tells them again. */
export function resetWorkingNotice(id: string): void {
  const file = read()
  write({
    armed: file.armed.filter((a) => a.id !== id),
    confirmed: file.confirmed.filter((c) => c !== id),
  })
}

/** Tokens just went through (any client). Exported for tests; at runtime
 *  startWorkingNotice() wires it to every recorded request. */
export function noteTokensFlowed(): void {
  const file = read()
  if (file.armed.length === 0) return
  const apps = file.armed.filter((a) => a.id !== FIRST_USE).map((a) => a.name)
  pending = { apps: [...new Set([...(pending?.apps ?? []), ...apps])] }
  write({
    armed: [],
    confirmed: [
      ...new Set([...file.confirmed, ...file.armed.map((a) => a.id)]),
    ],
  })
}

/** The notice waiting to be shown, if any; taking it clears it. */
export function takeWorkingNotice(): WorkingNotice | null {
  const notice = pending
  pending = null
  return notice
}

/** At sidecar start: arm the first-use notice for an install with no usage
 *  history, and start listening for tokens. */
export async function startWorkingNotice(): Promise<void> {
  onTokenUsageRecorded(noteTokensFlowed)
  const file = read()
  if (
    file.confirmed.includes(FIRST_USE)
    || file.armed.some((a) => a.id === FIRST_USE)
  ) {
    return
  }
  if (await hasAnyTokenUsage()) {
    // They've used Maximal before; never announce "it works" to them.
    write({ ...file, confirmed: [...file.confirmed, FIRST_USE] })
  } else {
    write({ ...file, armed: [...file.armed, { id: FIRST_USE, name: "" }] })
  }
}
