// Minimal HTTP client for the FigJam bridge (sends a pairing token only when the caller passes one).

// Read per call, not at load, so a caller (or test) can point an already-imported client elsewhere.
// The port goes into the 127.0.0.1 URL that carries the pairing token, so it must be a bare port
// number: anything else (e.g. `1@evil.example`) could move the URL's host off this machine.
function port(): string {
  const p = process.env.FIGJAM_BRIDGE_PORT ?? "4150"
  if (!/^\d{1,5}$/.test(p) || Number(p) < 1 || Number(p) > 65535)
    throw new Error(
      `FIGJAM_BRIDGE_PORT must be a port number from 1 to 65535, not ${JSON.stringify(p)}.`,
    )
  return p
}

function agent(): string {
  return process.env.FIGJAM_AGENT ?? "layout"
}

// No default board: the bridge can serve several FigJam files at once, and a
// layout read or write must never land on whichever one happens to be first.
function board(): string {
  const b = process.env.FIGJAM_BOARD
  if (!b)
    throw new Error(
      "Set FIGJAM_BOARD to the board name or id (bun run figjam -- status lists them).",
    )
  return b
}

// The caller decides whether to pass a token (see token.ts); this only sends it.
export async function tool(
  name: string,
  input: Record<string, unknown>,
  opts: { token?: string } = {},
): Promise<unknown> {
  const url = `http://127.0.0.1:${port()}/tool`
  const who = agent()
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-agent": who,
  }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  const res = await fetch(url, {
    method: "POST",
    redirect: "error",
    // By design: the operator-opted-in pairing token goes only to the bridge:
    // a fixed 127.0.0.1 host, a numeric port and no redirects. See ADR-0001.
    // codeql[js/file-access-to-http]
    headers,
    // By design: layouts the operator passes as files become tool input for the
    // same local bridge. See ADR-0001.
    // codeql[js/file-access-to-http]
    body: JSON.stringify({ board: board(), agent: who, name, input }),
  })
  const body = (await res.json()) as { ok?: boolean; result?: unknown }
  if (!body.ok)
    throw new Error(`${name}: ${JSON.stringify(body).slice(0, 600)}`)
  return body.result
}
