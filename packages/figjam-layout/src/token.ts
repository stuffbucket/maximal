// The bridge pairing token is a bridge-wide credential, so the layout tools only use it when the
// operator opts in: FIGJAM_TOKEN (the value) or FIGJAM_USE_PAIRING_TOKEN=1 (read the bridge's
// pairing-token file). Where that file lives is the bridge's business, not the client's.

import { pairingTokenPath } from "@stuffbucket/maximal-figjam-bridge/data-dir"
import { existsSync, readFileSync } from "node:fs"

export function bridgeToken(): string | undefined {
  if (process.env.FIGJAM_TOKEN) return process.env.FIGJAM_TOKEN
  if (process.env.FIGJAM_USE_PAIRING_TOKEN !== "1") return undefined
  const file = pairingTokenPath()
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined
}
