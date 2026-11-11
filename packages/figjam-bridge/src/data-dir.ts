/**
 * Where the FigJam bridge keeps its files. Kept free of SQLite so a client can
 * find the pairing token without loading the chat store.
 *
 * <data> is $COPILOT_API_HOME, else %APPDATA%\maximal on Windows, else
 * $XDG_DATA_HOME/maximal, else ~/.local/share/maximal.
 */
import os from "node:os"
import path from "node:path"

export function dataDir(): string {
  const env = process.env
  if (env.COPILOT_API_HOME) return env.COPILOT_API_HOME
  if (process.platform === "win32" && env.APPDATA)
    return path.join(env.APPDATA, "maximal")
  if (env.XDG_DATA_HOME) return path.join(env.XDG_DATA_HOME, "maximal")
  return path.join(os.homedir(), ".local", "share", "maximal")
}

// Bridge admin token for HTTP and the figjam CLI (panels never see it; they get
// their own token when the user approves their pairing request): 32 random
// bytes, base64url, at <data>/figjam/pairing-token, mode 0600.
export function pairingTokenPath(): string {
  return path.join(dataDir(), "figjam", "pairing-token")
}
