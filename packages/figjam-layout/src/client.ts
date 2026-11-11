// Minimal HTTP client for the FigJam bridge (reads the pairing token if present).
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const PORT = process.env.FIGJAM_BRIDGE_PORT ?? "4150"
const AGENT = process.env.FIGJAM_AGENT ?? "layout"

// No default board: the bridge can serve several FigJam files at once, and a
// layout read or write must never land on whichever one happens to be first.
function board(): string {
  const b = process.env.FIGJAM_BOARD
  if (!b) throw new Error("Set FIGJAM_BOARD to the board name or id (bun run figjam -- status lists them).")
  return b
}

// The pairing token is a bridge-wide credential: only used when the operator opts in, via
// FIGJAM_TOKEN (the value) or FIGJAM_USE_PAIRING_TOKEN=1 (read <data>/figjam/pairing-token).
function token(): string | undefined {
  if (process.env.FIGJAM_TOKEN) return process.env.FIGJAM_TOKEN
  if (process.env.FIGJAM_USE_PAIRING_TOKEN !== "1") return undefined
  const dirs = [process.env.COPILOT_API_HOME, join(homedir(), ".local/share/maximal")].filter(Boolean) as string[]
  for (const d of dirs) {
    const p = join(d, "figjam", "pairing-token")
    if (existsSync(p)) return readFileSync(p, "utf8").trim()
  }
  return undefined
}

export async function tool(name: string, input: Record<string, unknown>): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-agent": AGENT }
  const t = token()
  if (t) headers.authorization = `Bearer ${t}`
  const res = await fetch(`http://127.0.0.1:${PORT}/tool`, {
    method: "POST",
    headers,
    body: JSON.stringify({ board: board(), agent: AGENT, name, input }),
  })
  const body = await res.json()
  if (!body.ok) throw new Error(`${name}: ${JSON.stringify(body).slice(0, 600)}`)
  return body.result
}
