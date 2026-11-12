#!/usr/bin/env bun
/* eslint-disable complexity, max-lines-per-function -- moved from the spike as one command switch; it splits into modules when the bridge becomes the plugin-figjam connector. */
/**
 * Tiny CLI for the FigJam bridge (src/bridge.ts). Prints JSON; exits 1 when the
 * tool fails.
 *
 *   bun run figjam -- status
 *   bun run figjam -- boards                 # connected boards and their ids
 *   bun run figjam -- tools                  # names + descriptions
 *   bun run figjam -- tools connect          # one tool's full schema
 *   bun run figjam -- get_board '{"limit":50}'
 *   bun run figjam -- export_png '{"ids":["1:2"]}'   # prints the saved PNG path
 *   echo '{"code":"return figma.currentPage.name"}' | bun run figjam -- run_code -
 *   bun run figjam -- chats [boardId]        # saved chats, newest first
 *   bun run figjam -- search "sticky colors" [boardId]
 *   bun run figjam -- changes [--since n] [--follow]   # board change feed
 *   bun run figjam -- claim '{"ids":["1:2"],"ttl":300,"note":"restyling"}'
 *   bun run figjam -- claims                 # live claims on the board
 *   bun run figjam -- release <claimId>
 *   bun run figjam -- pairs                  # pending pairing requests + paired panels
 *   bun run figjam -- approve [name]         # approve a panel (no name: the only pending one)
 *   bun run figjam -- deny [name]
 *   bun run figjam -- forget <clientId>      # revoke a paired panel
 *   bun run figjam -- admin-token [--rotate] # print (or replace) the bridge admin token
 *
 * Every request carries the bridge admin token as a bearer token, read from
 * <data>/figjam/pairing-token (see data-dir.ts for <data>). Panels never
 * need it: they pair by approval (the name is the panel's instance name,
 * shown in Figma's window title, e.g. "Agent · grumpy-urchin").
 *
 * Options: --port <n> (default $FIGJAM_BRIDGE_PORT or 4150), --inline (keep
 * export base64 in the output), --board <id | file key | name> (default
 * $FIGJAM_BOARD; needed when more than one board is connected), --agent
 * <name> (default $FIGJAM_AGENT or "cli"; tags this agent's changes and claims).
 */

import { loadPairingToken, pairingTokenPath } from "./chats-store"

// The port goes into the 127.0.0.1 URL that carries the pairing token, so it
// must be a bare port number.
function bridgePort(raw: string): number {
  if (!/^\d{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    console.error(
      `The bridge port must be a number from 1 to 65535, not ${JSON.stringify(raw)}.`,
    )
    process.exit(2)
  }
  return Number(raw)
}

const args = process.argv.slice(2)
let port = bridgePort(process.env.FIGJAM_BRIDGE_PORT ?? "4150")
let inline = false
let board = process.env.FIGJAM_BOARD || undefined
let agent = process.env.FIGJAM_AGENT || "cli"
let since: number | undefined
let follow = false
let rotate = false
const rest: Array<string> = []
for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--port": {
      port = bridgePort(args[++i] ?? "")
      break
    }
    case "--board": {
      board = args[++i]
      break
    }
    case "--inline": {
      inline = true
      break
    }
    case "--agent": {
      agent = args[++i]
      break
    }
    case "--since": {
      since = Number(args[++i])
      break
    }
    case "--follow": {
      follow = true
      break
    }
    case "--rotate": {
      rotate = true
      break
    }
    default: {
      rest.push(args[i])
    }
  }
}
const base = `http://127.0.0.1:${port}`
const [command, rawInput]: Array<string | undefined> = rest

// Bearer token on every request (the bridge creates the file on first start).
const realFetch = globalThis.fetch
const fetch = (input: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  const token = loadPairingToken({ create: false })
  if (token) headers.set("authorization", `Bearer ${token}`)
  return realFetch(input, { ...init, headers, redirect: "error" })
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

// `changes`: --follow without --since starts at the latest change; plain
// `changes` prints the log.
async function changes(): Promise<number> {
  let cursor = since
  for (;;) {
    const params = new URLSearchParams()
    if (board) params.set("board", board)
    params.set("since", String(cursor ?? 0))
    if (follow && cursor !== undefined) params.set("wait", "25")
    const res = await fetch(`${base}/changes?${params.toString()}`)
    const body = (await res.json()) as {
      seq?: number
      latest?: number
      changes?: Array<unknown>
      error?: string
    }
    if (!res.ok) {
      console.error(body.error ?? `HTTP ${res.status}`)
      return 1
    }
    if (!follow) {
      print(body)
      return 0
    }
    if (cursor === undefined) cursor = body.latest ?? 0
    else {
      for (const c of body.changes ?? []) console.log(JSON.stringify(c))
      cursor = body.seq ?? cursor
    }
  }
}

async function main(): Promise<number> {
  if (!command || command === "help" || command === "--help") {
    console.log(
      "usage: bun run figjam -- <status | boards | pairs | approve [name] | deny [name] | forget <clientId> | admin-token [--rotate] | tools [name] | chats [boardId] | search <text> [boardId] | changes [--since n] [--follow] | claim <json> | claims | release <id> | <tool> [json | -]> [--board id] [--agent name] [--port n] [--inline]",
    )
    return command ? 0 : 1
  }
  if (command === "admin-token") {
    const token = loadPairingToken({ rotate })
    console.log(token)
    console.error(
      rotate ?
        `New bridge admin token (${pairingTokenPath()}). Agents using curl need the new one; panels are unaffected.`
      : `Bridge admin token from ${pairingTokenPath()} (for HTTP/CLI only; panels pair with \`approve\`).`,
    )
    return 0
  }
  if (command === "pairs" || command === "pair") {
    const res = await fetch(`${base}/pair`)
    const body = (await res.json()) as {
      pending?: Array<{
        name: string
        board: string
        fileKey: string | null
        user: string | null
        expiresInSec: number
      }>
      clients?: Array<{
        id: string
        label: string
        createdAt: string
        lastSeen: string
        boards: Array<string>
      }>
      error?: string
    }
    if (!res.ok) {
      console.error(body.error ?? `HTTP ${res.status}`)
      return 1
    }
    console.log(
      body.pending?.length ? "Pending:" : "No pending pairing requests.",
    )
    for (const r of body.pending ?? []) {
      console.log(
        `  ${r.name.padEnd(20)} board "${r.board}"${r.fileKey ? ` (${r.fileKey})` : ""}${r.user ? ` · ${r.user}` : ""} · ${r.expiresInSec}s left · bun run figjam -- approve ${r.name}`,
      )
    }
    console.log(body.clients?.length ? "Paired:" : "No paired panels.")
    for (const c of body.clients ?? []) {
      console.log(
        `  ${c.id.padEnd(10)} ${c.label} · last seen ${c.lastSeen.slice(0, 16).replace("T", " ")}${c.boards.length > 0 ? ` · connected: ${c.boards.join(", ")}` : ""}`,
      )
    }
    return 0
  }
  if (command === "approve" || command === "deny" || command === "forget") {
    if (command === "forget" && !rawInput) {
      console.error(
        "usage: bun run figjam -- forget <clientId>   (bun run figjam -- pairs lists them)",
      )
      return 1
    }
    const res = await fetch(`${base}/pair/${command}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        command === "forget" ? { clientId: rawInput } : { name: rawInput },
      ),
    })
    const body = (await res.json()) as {
      ok?: boolean
      error?: string
      message?: string
      alreadyPaired?: boolean
      clientId?: string
      name?: string
      board?: string
      fileKey?: string | null
      pending?: Array<{ name: string; board: string; fileKey: string | null }>
    }
    if (!res.ok || !body.ok) {
      console.error(body.error ?? `HTTP ${res.status}`)
      if (body.pending?.length) {
        console.error("Waiting for approval now:")
        for (const r of body.pending)
          console.error(
            `  ${r.name}  board "${r.board}"${r.fileKey ? ` (${r.fileKey})` : ""}`,
          )
      }
      return 1
    }
    if (body.alreadyPaired) {
      console.log(body.message)
      return 0
    }
    if (command === "approve")
      console.log(
        `Paired ${body.name} (board "${body.board}"${body.fileKey ? `, ${body.fileKey}` : ""}) as ${body.clientId}.`,
      )
    else if (command === "deny") console.log("Denied.")
    else console.log(`Forgot ${rawInput}; its panel will ask to pair again.`)
    return 0
  }
  if (command === "status") {
    print(await (await fetch(`${base}/status`)).json())
    return 0
  }
  if (command === "boards") {
    const body = (await (await fetch(`${base}/status`)).json()) as {
      boards?: Array<{
        id: string
        name?: string
        page?: string
        inFlight: number
        plugin?: { version?: string } | null
      }>
    }
    if (!body.boards) {
      console.error(
        "The bridge didn't accept the admin token: run this on the machine running the bridge (same data dir).",
      )
      return 1
    }
    if (body.boards.length === 0)
      console.error(
        "No board connected. Turn on remote control in the plugin panel.",
      )
    for (const b of body.boards) {
      console.log(
        `${b.id.padEnd(8)} ${b.name ?? "?"} · ${b.page ?? "?"}  (v${b.plugin?.version ?? "?"}, ${b.inFlight} in flight)`,
      )
    }
    return 0
  }
  if (command === "chats" || command === "search") {
    const params = new URLSearchParams()
    const boardId = command === "chats" ? rawInput : rest[2]
    if (boardId) params.set("boardId", boardId)
    if (command === "search") {
      if (!rawInput) {
        console.error("usage: bun run figjam -- search <text> [boardId]")
        return 1
      }
      params.set("q", rawInput)
    }
    const res = await fetch(
      `${base}/chats${command === "search" ? "/search" : ""}?${params.toString()}`,
    )
    const body = (await res.json()) as {
      chats?: Array<{
        id: string
        title: string
        updatedAt: string
        boardId: string
        boardName?: string | null
        turns: number
      }>
      results?: Array<{
        id: string
        title: string
        updatedAt: string
        boardId: string
        boardName?: string | null
        snippet: string
      }>
      error?: string
    }
    if (!res.ok) {
      console.error(body.error ?? `HTTP ${res.status}`)
      return 1
    }
    for (const c of body.chats ?? body.results ?? []) {
      console.log(
        `${c.id}  ${c.updatedAt.slice(0, 16).replace("T", " ")}  [${c.boardName ?? c.boardId}]  ${c.title}`,
      )
      if ("snippet" in c)
        console.log(
          `    ${c.snippet.replaceAll(/<\/?mark>/g, "*").replaceAll(/\s+/g, " ")}`,
        )
    }
    return 0
  }
  if (command === "changes") return changes()
  if (command === "claim" || command === "claims" || command === "release") {
    let res: Response
    if (command === "claims")
      res = await fetch(
        `${base}/claims${board ? `?board=${encodeURIComponent(board)}` : ""}`,
      )
    else if (command === "release") {
      if (!rawInput) {
        console.error("usage: bun run figjam -- release <claimId>")
        return 1
      }
      res = await fetch(`${base}/claims/${encodeURIComponent(rawInput)}`, {
        method: "DELETE",
      })
    } else {
      let claim: Record<string, unknown>
      try {
        claim = JSON.parse(
          rawInput === "-" ? await Bun.stdin.text() : (rawInput ?? ""),
        ) as Record<string, unknown>
      } catch {
        console.error(
          `usage: bun run figjam -- claim '{"ids":["1:2"],"rect":{"x":0,"y":0,"w":800,"h":600},"ttl":300,"note":"..."}'`,
        )
        return 1
      }
      res = await fetch(`${base}/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ board, agent, ...claim }),
      })
    }
    print(await res.json())
    return res.ok ? 0 : 1
  }
  if (command === "tools") {
    const query = board ? `?board=${encodeURIComponent(board)}` : ""
    const body = (await (await fetch(`${base}/tools${query}`)).json()) as {
      tools?: Array<{ name: string; description: string }>
      error?: string
    }
    if (!body.tools) {
      console.error(body.error ?? "No tools reported.")
      return 1
    }
    if (rawInput) {
      const one = body.tools.find((t) => t.name === rawInput)
      if (!one) {
        console.error(`No tool ${rawInput}.`)
        return 1
      }
      print(one)
    } else {
      for (const t of body.tools)
        console.log(`${t.name.padEnd(18)} ${t.description}`)
      if (body.tools.length === 0)
        console.error(
          "No tools reported: is the plugin connected (and reloaded since the bridge started)?",
        )
    }
    return 0
  }
  let input: unknown = {}
  const text = rawInput === "-" ? await Bun.stdin.text() : rawInput
  if (text && text.trim()) {
    try {
      input = JSON.parse(text)
    } catch (error) {
      console.error(
        `Input isn't JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
      return 1
    }
  }
  const res = await fetch(`${base}/tool`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: command, input, inline, board, agent }),
  })
  const body = (await res.json()) as { ok?: boolean }
  print(body)
  return body.ok ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(
      `Can't reach the bridge at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  },
)
