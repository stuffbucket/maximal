#!/usr/bin/env bun
/* eslint-disable complexity, max-lines, max-lines-per-function, max-params -- moved from the spike as one file; it splits into modules when it becomes the plugin-figjam connector. */
/**
 * Bridge between a local agent (curl, Claude Code, the figjam CLI) and the Maximal
 * Agent FigJam plugin. Each plugin panel connects here over a WebSocket when
 * its "Let Claude Code drive this board" switch is on; tool calls POSTed to
 * /tool run in that board through the plugin's own tools and return their
 * result.
 *
 * Several boards can be connected at once. Each panel has a short id (shown
 * in the panel and in GET /status). With one board connected, calls go to it;
 * with more, pass `board` (an id, file key, or file name) in the POST body or
 * as ?board= on GET /tools.
 *
 *   bun run figjam:bridge             # listens on 127.0.0.1:4150
 *   curl -s localhost:4150/status     # lists connected boards
 *   curl -s localhost:4150/tools      # tool schemas, as the plugin reports them
 *   curl -s localhost:4150/tool -d '{"name":"get_board","input":{},"board":"k3x9qa"}'
 *
 * export_png images are written to <data>/figjam/exports/ and returned as file paths
 * (add "inline": true to the POST body to keep the base64 too). create_image
 * calls with a `url` and no `base64` are fetched here first, since the plugin
 * itself can only reach the hosts its manifest allows.
 *
 * Agents name themselves with "agent" in the POST body (or an X-Agent header);
 * the plugin tags the board changes each call makes with "agent:<name>".
 * Write tools run one at a time per board, in arrival order; reads run
 * concurrently. GET /changes?board=&since=&wait= returns the board's change
 * feed (long-polls up to 25 s). POST /claims takes advisory locks on node ids
 * or an area; another agent's write that touches them gets 409.
 *
 * Loopback only, and paired. A panel pairs by approval: its first hello (no
 * token, or one the bridge doesn't know) becomes a pending request with a
 * 6-digit code shown in the panel and logged here; `bun run figjam -- approve`
 * (or POST /pair/approve) mints a per-client token that the panel keeps and
 * sends in later hellos. Only token hashes are stored, in
 * <data>/figjam/clients.json (mode 0600); `bun run figjam -- forget <clientId>`
 * revokes one. A pending socket gets nothing but pairing messages.
 *
 * The HTTP API needs the bridge admin token (<data>/figjam/pairing-token,
 * mode 0600; the figjam CLI sends it for you) as `Authorization: Bearer <token>`
 * and refuses any request with an Origin header, so no web page can reach it.
 * GET /status without the token answers only {ok, version, paired: false}.
 * The panel's chat storage runs over the paired socket ("chats" /
 * "chats-reply").
 */

import type { ServerWebSocket } from "bun"

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"

import {
  ChatStore,
  StoreError,
  dataDir,
  loadPairingToken,
  pairingTokenPath,
} from "./chats-store"

const BRIDGE_VERSION = "0.7.0"
const PORT = Number(process.env.FIGJAM_BRIDGE_PORT ?? 4150)
const TIMEOUT_MS = 120_000
const EXPORT_DIR = path.join(dataDir(), "figjam", "exports")
const MAX_FETCH_BYTES = 20 * 1024 * 1024

interface Pending {
  resolve: (value: Response) => void
  timer: ReturnType<typeof setTimeout>
  name: string
  started: number
  inline: boolean
  board: Board
}

interface PluginInfo {
  version?: string
  build?: string
  loadedAt?: string
}

type Json = Record<string, unknown>

interface Board {
  id: string
  ws: ServerWebSocket<SocketData>
  info: Json
  plugin?: PluginInfo
  tools: Array<unknown>
  connectedAt: string
  clientId: string
}

// Set once the socket's hello arrives: id when paired, pairId while pending.
interface SocketData {
  id?: string
  pairId?: string
}

// A message from a panel's socket, as parsed (fields depend on `type`).
interface SocketMessage extends Json {
  type?: string
  id?: string
  session?: unknown
  ok?: boolean
  result?: unknown
  error?: string
  board?: Json
  plugin?: PluginInfo
  tools?: Array<unknown>
  token?: unknown
  reqId?: unknown
  op?: unknown
}

// One change, as the sandbox reported it, stamped with the bridge's seq.
interface ChangeEntry extends Json {
  seq: number
  at: string
  actor: string
}

// Advisory lock an agent takes on nodes (ids) or an area (rect) of a board.
interface Claim {
  id: string
  board: string
  agent: string
  ids: Array<string>
  rect: { pageId?: string; x: number; y: number; w: number; h: number } | null
  ttl: number
  note: string | null
  createdAt: string
  expiresAt: string
}

// Per-board state that outlives a socket: keyed by the panel's boardId (so a
// plugin re-run keeps the change log and claims), else by the session id.
interface BoardState {
  seq: number
  changes: Array<ChangeEntry>
  waiters: Set<() => void>
  writeTail: Promise<void>
  claims: Map<string, Claim>
}

const MAX_CHANGES = 5_000
const MAX_WAIT_S = 25
const DEFAULT_CLAIM_TTL = 120
const MAX_CLAIM_TTL = 900
const READ_TOOL =
  /^(?:get_|find_|list_|board_tree$|read_markup$|review_layout$|export_png$)/

const boards = new Map<string, Board>()
const states = new Map<string, BoardState>()
// Last time each agent called the bridge (ms); claims lapse ttl after it.
const agentSeen = new Map<string, number>()
const chats = new ChatStore()
loadPairingToken() // create it on first start
const pending = new Map<string, Pending>()
let seq = 0

const log = (line: string) =>
  console.log(`${new Date().toISOString().slice(11, 19)} ${line}`)

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// A plugin-reported field as text: strings as-is, numbers and booleans
// stringified, anything else (missing, or not a scalar) the fallback.
function text(value: unknown, fallback: string): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean")
    return String(value)
  return fallback
}

// Constant-time token check. Never log the token.
function tokenMatches(candidate: unknown): boolean {
  if (typeof candidate !== "string" || !candidate) return false
  // Re-read each time so `bun run figjam -- admin-token --rotate` takes effect without a restart.
  const a = Buffer.from(candidate.trim())
  const b = Buffer.from(loadPairingToken())
  if (a.length !== b.length) {
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

function bearer(request: Request): string | null {
  // Header values arrive trimmed, so the token starts at a non-space.
  const m = /^Bearer\s+(\S.*)$/i.exec(
    request.headers.get("authorization") ?? "",
  )
  return m ? m[1] : null
}

function label(b: Board): string {
  return `[${b.id} ${text(b.info.name, "?")}]`
}

// ── Panel pairing (approve once) ─────────────────────────────────────────
// A paired client is one panel install (per Figma user): its token's SHA-256
// is kept in clients.json, never the token itself. Never log a token.

interface PairedClient {
  id: string
  hash: string // sha256 hex of the client token
  label: string
  createdAt: string
  lastSeen: string
}

interface HelloMsg {
  session?: unknown
  token?: unknown
  user?: unknown
  board?: Json
  plugin?: PluginInfo
  tools?: Array<unknown>
}

interface PairRequest {
  requestId: string
  name: string // the panel's instance name (its session, e.g. "grumpy-urchin"): a label, not a secret
  ws: ServerWebSocket<SocketData>
  hello: HelloMsg
  board: string
  fileKey: string | null
  boardId: string | null
  user: string | null
  createdAt: number
  timer: ReturnType<typeof setTimeout>
}

const PAIR_TTL_S = Number(process.env.FIGJAM_PAIR_TTL_S ?? 300)
const MAX_PAIR_REQUESTS = 3
const pairRequests = new Map<string, PairRequest>()

// What happened to recent requests, by instance name, so approve/deny can say
// "already paired" or "expired" instead of a bare "not found".
type PairOutcome =
  | { outcome: "approved"; at: number; board: string; clientId: string }
  | { outcome: "denied" | "expired"; at: number; board: string }
  | { outcome: "replaced"; at: number; board: string; replacedBy: string }
const pairHistory = new Map<string, PairOutcome>()
const BRIDGE_STARTED_AT = Date.now()

function remember(name: string, entry: PairOutcome): void {
  pairHistory.delete(name)
  pairHistory.set(name, entry)
  while (pairHistory.size > 50)
    pairHistory.delete(pairHistory.keys().next().value as string)
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  return `at ${new Date(at).toLocaleTimeString()}`
}
const clientsPath = () => path.join(dataDir(), "figjam", "clients.json")
let clients: Array<PairedClient> = loadClients()

function loadClients(): Array<PairedClient> {
  try {
    if (!existsSync(clientsPath())) return []
    const value = JSON.parse(readFileSync(clientsPath(), "utf8")) as {
      clients?: Array<unknown>
    }
    return Array.isArray(value.clients) ?
        value.clients.filter(
          (c): c is PairedClient =>
            isObject(c)
            && typeof c.hash === "string"
            && typeof c.id === "string",
        )
      : []
  } catch (error) {
    log(
      `couldn't read ${clientsPath()}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return []
  }
}

function saveClients(): void {
  const file = clientsPath()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ clients }, null, 2)}\n`, {
    mode: 0o600,
  })
  chmodSync(file, 0o600)
}

const sha256 = (value: string) => createHash("sha256").update(value).digest()

// Constant-time: compares against every stored hash, no early exit.
function clientForToken(candidate: unknown): PairedClient | undefined {
  if (typeof candidate !== "string" || !candidate) return undefined
  const h = sha256(candidate.trim())
  let found: PairedClient | undefined
  for (const c of clients) {
    const stored = Buffer.from(c.hash, "hex")
    if (stored.length === h.length && timingSafeEqual(stored, h) && !found)
      found = c
  }
  return found
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null

function helloUser(hello: HelloMsg): string | null {
  return str(hello.user) ?? (isObject(hello.user) ? str(hello.user.name) : null)
}

function pairView(r: PairRequest) {
  return {
    requestId: r.requestId,
    name: r.name,
    board: r.board,
    fileKey: r.fileKey,
    boardId: r.boardId,
    user: r.user,
    createdAt: new Date(r.createdAt).toISOString(),
    expiresInSec: Math.max(
      0,
      Math.round(PAIR_TTL_S - (Date.now() - r.createdAt) / 1000),
    ),
  }
}

function dropPairRequest(r: PairRequest): void {
  clearTimeout(r.timer)
  pairRequests.delete(r.requestId)
  if (r.ws.data.pairId === r.requestId) r.ws.data.pairId = undefined
}

function startPairRequest(
  ws: ServerWebSocket<SocketData>,
  hello: HelloMsg,
  reason: "no-token" | "unknown-token",
): void {
  const info = isObject(hello.board) ? hello.board : {}
  const boardId = str(info.boardId)
  // The panel's instance name is what the user confirms in the CLI. Older
  // panels don't send one; give them one.
  const name = (
    str(hello.session) ?? `panel-${randomBytes(2).toString("hex")}`
  ).toLowerCase()
  // A newer request from the same board (or a re-hello on this socket)
  // replaces the older one.
  for (const other of pairRequests.values()) {
    if (other.ws === ws || (boardId && other.boardId === boardId)) {
      dropPairRequest(other)
      if (other.name !== name)
        remember(other.name, {
          outcome: "replaced",
          at: Date.now(),
          board: other.board,
          replacedBy: name,
        })
      if (other.ws !== ws)
        other.ws.close(4000, "replaced by a newer pairing request")
    }
  }
  // Two pending requests must never share a name, or approving one by name
  // could approve the other: refuse the newer.
  if ([...pairRequests.values()].some((r) => r.name === name)) {
    log(`pairing request refused: name ${name} is already pending`)
    ws.send(JSON.stringify({ type: "pair-name-in-use", name }))
    ws.close(4409, "name in use")
    return
  }
  if (pairRequests.size >= MAX_PAIR_REQUESTS) {
    log(`pairing request refused: ${MAX_PAIR_REQUESTS} already pending`)
    ws.send(JSON.stringify({ type: "pair-busy", retryAfterSec: PAIR_TTL_S }))
    ws.close(4429, "too many pending pairing requests")
    return
  }
  const requestId = `q${randomBytes(6).toString("hex")}`
  const r: PairRequest = {
    requestId,
    name,
    ws,
    hello,
    board: str(info.name) ?? str(info.fileName) ?? "untitled board",
    fileKey: str(info.fileKey),
    boardId,
    user: helloUser(hello),
    createdAt: Date.now(),
    timer: setTimeout(() => {
      if (pairRequests.get(requestId) !== r) return
      dropPairRequest(r)
      remember(name, { outcome: "expired", at: Date.now(), board: r.board })
      log(`pairing request ${name} expired`)
      ws.send(JSON.stringify({ type: "pair-expired" }))
      ws.close(4408, "pairing request expired")
    }, PAIR_TTL_S * 1000),
  }
  pairRequests.set(requestId, r)
  ws.data.pairId = requestId
  ws.send(
    JSON.stringify({
      type: "pair-pending",
      requestId,
      name,
      expiresInSec: PAIR_TTL_S,
      reason,
      version: BRIDGE_VERSION,
    }),
  )
  const portFlag = PORT === 4150 ? "" : ` --port ${PORT}`
  const who = r.user ? ` · ${r.user}` : ""
  log(
    `Pairing request: ${name} · board "${r.board}"${r.fileKey ? ` (${r.fileKey})` : ""}${who} · approve: bun run figjam -- approve ${name}${portFlag}`,
  )
}

// Finds the request a CLI/HTTP call means: by name, or the only one pending.
// A miss explains what happened to that name instead of a bare "not found".
function findPairRequest(
  rawName: unknown,
  action: "approve" | "deny",
): { request: PairRequest } | { response: Response } {
  const name = typeof rawName === "string" ? rawName.trim().toLowerCase() : ""
  const pending = [...pairRequests.values()].map((r) => pairView(r))
  if (!name) {
    if (pairRequests.size === 1)
      return { request: pairRequests.values().next().value as PairRequest }
    if (pairRequests.size === 0)
      return {
        response: json(
          {
            ok: false,
            error: "No panel is waiting for approval right now.",
            pending,
          },
          404,
        ),
      }
    return {
      response: json(
        {
          ok: false,
          error:
            "Several panels are waiting: pass the name shown in the panel's window title.",
          pending,
        },
        409,
      ),
    }
  }
  for (const r of pairRequests.values())
    if (r.name === name) return { request: r }
  return { response: explainMissing(name, action, pending) }
}

function explainMissing(
  name: string,
  action: "approve" | "deny",
  pending: Array<ReturnType<typeof pairView>>,
): Response {
  const connected = boards.get(name)
  const past = pairHistory.get(name)
  if (connected || past?.outcome === "approved") {
    const clientId =
      connected?.clientId
      ?? (past?.outcome === "approved" ? past.clientId : undefined)
    const when =
      past?.outcome === "approved" ?
        `was approved ${ago(past.at)}`
      : "is already paired"
    const state =
      connected ? "and is connected" : "but isn't connected right now"
    const status = `${name} ${when} (client ${clientId ?? "unknown"}) ${state}.`
    // Approving twice is a no-op, not an error.
    if (action === "approve")
      return json({
        ok: true,
        alreadyPaired: true,
        name,
        clientId,
        message: `${status} Nothing to do.`,
      })
    return json(
      {
        ok: false,
        error: `${status} To revoke it: bun run figjam -- forget ${clientId ?? "<clientId>"}`,
        pending,
      },
      409,
    )
  }
  if (past?.outcome === "denied") {
    return json(
      {
        ok: false,
        error: `${name}'s request was denied ${ago(past.at)}. The panel can ask again from Settings → Ask again.`,
        pending,
      },
      410,
    )
  }
  if (past?.outcome === "expired") {
    return json(
      {
        ok: false,
        error: `${name}'s request expired ${ago(past.at)} (requests last ${PAIR_TTL_S >= 60 ? `${Math.round(PAIR_TTL_S / 60)} min` : `${PAIR_TTL_S}s`}). In the panel: Settings → Ask again, then approve the name it shows.`,
        pending,
      },
      410,
    )
  }
  if (past?.outcome === "replaced") {
    return json(
      {
        ok: false,
        error: `${name}'s request was replaced ${ago(past.at)} by a newer one from the same board: ${past.replacedBy}.`,
        pending,
      },
      410,
    )
  }
  return json(
    {
      ok: false,
      error: `No pairing request from ${name} has reached this bridge since it started (${new Date(BRIDGE_STARTED_AT).toLocaleTimeString()}). Check the name in the panel's window title, and that "Let Claude Code drive this board" is on.`,
      pending,
    },
    404,
  )
}

function approvePairRequest(r: PairRequest): PairedClient {
  dropPairRequest(r)
  const token = randomBytes(32).toString("base64url")
  const now = new Date().toISOString()
  const client: PairedClient = {
    id: `c${randomBytes(4).toString("hex")}`,
    hash: sha256(token).toString("hex"),
    label: `${r.user ? `${r.user} · ` : ""}${r.name} · first paired on "${r.board}"`,
    createdAt: now,
    lastSeen: now,
  }
  clients.push(client)
  saveClients()
  remember(r.name, {
    outcome: "approved",
    at: Date.now(),
    board: r.board,
    clientId: client.id,
  })
  log(`approved pairing ${client.id} (${client.label})`)
  r.ws.send(
    JSON.stringify({
      type: "paired",
      version: BRIDGE_VERSION,
      token,
      clientId: client.id,
    }),
  )
  admit(r.ws, r.hello, client)
  return client
}

function forgetClient(clientId: string): boolean {
  const before = clients.length
  clients = clients.filter((c) => c.id !== clientId)
  if (clients.length === before) return false
  saveClients()
  for (const b of boards.values()) {
    if (b.clientId !== clientId) continue
    boards.delete(b.id)
    failPending(b, "The panel's pairing was revoked.")
    b.ws.send(JSON.stringify({ type: "unpaired" }))
    b.ws.close(4401, "pairing revoked")
  }
  log(`forgot paired client ${clientId}`)
  return true
}

async function handlePair(request: Request, url: URL): Promise<Response> {
  if (url.pathname === "/pair" && request.method === "GET") {
    const connected = new Map<string, Array<string>>()
    for (const b of boards.values())
      connected.set(b.clientId, [...(connected.get(b.clientId) ?? []), b.id])
    return json({
      pending: [...pairRequests.values()].map((r) => pairView(r)),
      clients: clients.map(({ hash: _hash, ...c }) => ({
        ...c,
        boards: connected.get(c.id) ?? [],
      })),
    })
  }
  if (request.method !== "POST")
    return json(
      {
        error:
          "Use GET /pair or POST /pair/approve | /pair/deny | /pair/forget.",
      },
      405,
    )
  let body: Json = {}
  try {
    const text = await request.text()
    if (text.trim()) body = JSON.parse(text) as Json
  } catch {
    return json({ ok: false, error: "Body must be JSON." }, 400)
  }
  if (url.pathname === "/pair/approve" || url.pathname === "/pair/deny") {
    const found = findPairRequest(
      body.name,
      url.pathname === "/pair/approve" ? "approve" : "deny",
    )
    if ("response" in found) return found.response
    const r = found.request
    if (url.pathname === "/pair/approve") {
      const client = approvePairRequest(r)
      return json({
        ok: true,
        clientId: client.id,
        label: client.label,
        name: r.name,
        board: r.board,
        fileKey: r.fileKey,
      })
    }
    dropPairRequest(r)
    remember(r.name, { outcome: "denied", at: Date.now(), board: r.board })
    log(`denied pairing request ${r.name} (board "${r.board}")`)
    r.ws.send(JSON.stringify({ type: "pair-denied" }))
    r.ws.close(4403, "pairing denied")
    return json({ ok: true, denied: pairView(r) })
  }
  if (url.pathname === "/pair/forget") {
    const id = str(body.clientId)
    if (!id) return json({ ok: false, error: "Body must be {clientId}." }, 400)
    return forgetClient(id) ?
        json({ ok: true })
      : json({ ok: false, error: `No paired client ${id}.` }, 404)
  }
  return json({ error: "Not found." }, 404)
}

// Registers a paired socket as a board (the old paired-hello path).
function admit(
  ws: ServerWebSocket<SocketData>,
  msg: HelloMsg,
  client: PairedClient,
): void {
  // Older panels don't send a session; give them one so they still work.
  const id =
    typeof msg.session === "string" && msg.session ? msg.session : `p${++seq}`
  const previous = boards.get(id)
  ws.data.id = id
  const b: Board = {
    id,
    ws,
    info: isObject(msg.board) ? msg.board : {},
    plugin: msg.plugin,
    tools: Array.isArray(msg.tools) ? msg.tools : [],
    connectedAt: new Date().toISOString(),
    clientId: client.id,
  }
  boards.set(id, b)
  // Register the new socket first so the old one's close handler ignores it.
  if (previous && previous.ws !== ws) {
    failPending(previous, "The board reconnected.")
    previous.ws.close(
      4000,
      "replaced by a newer connection from the same panel",
    )
  }
  // A new panel session on the same board (plugin re-run) replaces the old one.
  const boardKey =
    typeof b.info.boardId === "string" && b.info.boardId ? b.info.boardId : null
  if (boardKey) {
    for (const other of boards.values()) {
      if (other === b || other.info.boardId !== boardKey) continue
      boards.delete(other.id)
      failPending(other, "The board reconnected from a new panel.")
      other.ws.close(4000, "replaced by a newer connection from the same board")
      log(`${label(other)} replaced by session ${id}`)
    }
  }
  const v =
    b.plugin ?
      `v${b.plugin.version} build ${b.plugin.build}`
    : "unknown version"
  log(
    `${label(b)} connected · client ${client.id} · page ${text(b.info.page, "?")} · plugin ${v} · ${b.tools.length} tools · ${boards.size} board(s)`,
  )
}

function summary(b: Board) {
  let inFlight = 0
  for (const entry of pending.values()) if (entry.board === b) inFlight++
  const st = stateOf(b)
  return {
    id: b.id,
    ...b.info,
    plugin: b.plugin ?? null,
    inFlight,
    connectedAt: b.connectedAt,
    clientId: b.clientId,
    changesSeq: st.seq,
    claims: liveClaims(st).length,
  }
}

function stateKey(b: Board): string {
  return typeof b.info.boardId === "string" && b.info.boardId ?
      b.info.boardId
    : b.id
}

function stateOf(b: Board): BoardState {
  const key = stateKey(b)
  let st = states.get(key)
  if (!st) {
    st = {
      seq: 0,
      changes: [],
      waiters: new Set(),
      writeTail: Promise.resolve(),
      claims: new Map(),
    }
    states.set(key, st)
  }
  return st
}

// ---------------------------------------------------------------- change log

function recordChanges(b: Board, msg: Json): number {
  const st = stateOf(b)
  const list = Array.isArray(msg.changes) ? msg.changes : []
  const target = isObject(msg.target) ? msg.target : {}
  const at = new Date().toISOString()
  for (const change of list) {
    if (!isObject(change)) continue
    st.changes.push({
      ...change,
      seq: ++st.seq,
      at,
      actor: typeof change.actor === "string" ? change.actor : "user",
      pageId: change.pageId ?? target.pageId ?? null,
    })
  }
  if (st.changes.length > MAX_CHANGES)
    st.changes.splice(0, st.changes.length - MAX_CHANGES)
  for (const wake of st.waiters) wake()
  return list.length
}

async function handleChanges(url: URL): Promise<Response> {
  const picked = pickBoard(url.searchParams.get("board"))
  if ("response" in picked) return picked.response
  const st = stateOf(picked.board)
  const since = Math.max(0, Number(url.searchParams.get("since") ?? 0) || 0)
  const wait = Math.min(
    MAX_WAIT_S,
    Math.max(0, Number(url.searchParams.get("wait") ?? 0) || 0),
  )
  const limit = Math.min(
    MAX_CHANGES,
    Math.max(1, Number(url.searchParams.get("limit") ?? 1000) || 1000),
  )
  if (wait > 0 && st.seq <= since) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        st.waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, wait * 1000)
      st.waiters.add(done)
    })
  }
  const newer = st.changes.filter((c) => c.seq > since)
  const page = newer.slice(0, limit)
  const oldest = st.changes[0]?.seq ?? st.seq + 1
  return json({
    board: picked.board.id,
    seq: page.at(-1)?.seq ?? st.seq,
    latest: st.seq,
    more: newer.length > page.length,
    // Some changes after `since` were dropped from the ring buffer.
    truncated: since + 1 < oldest && st.seq > since,
    changes: page,
  })
}

// ---------------------------------------------------------------- claims

function claimExpiry(c: Claim): number {
  return (
    Math.max(Date.parse(c.createdAt), agentSeen.get(c.agent) ?? 0)
    + c.ttl * 1000
  )
}

function liveClaims(st: BoardState): Array<Claim> {
  const now = Date.now()
  const live: Array<Claim> = []
  for (const [id, c] of st.claims) {
    const expires = claimExpiry(c)
    if (expires <= now) st.claims.delete(id)
    else {
      c.expiresAt = new Date(expires).toISOString()
      live.push(c)
    }
  }
  return live
}

function touchAgent(agent: string): void {
  agentSeen.set(agent, Date.now())
}

function rectsOverlap(
  a: NonNullable<Claim["rect"]>,
  b: NonNullable<Claim["rect"]>,
): boolean {
  if (a.pageId && b.pageId && a.pageId !== b.pageId) return false
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  )
}

// Node ids a tool input touches: id, ids, nodeId, sectionId and expect.revs
// keys, also inside batch calls. Plus any x/y points it places things at.
function touched(
  name: unknown,
  input: unknown,
  ids = new Set<string>(),
  points: Array<{ x: number; y: number }> = [],
) {
  if (!isObject(input)) return { ids, points }
  if (name === "batch" && Array.isArray(input.calls)) {
    for (const call of input.calls)
      if (isObject(call)) touched(call.name, call.input, ids, points)
  }
  for (const key of ["id", "nodeId", "sectionId"])
    if (typeof input[key] === "string") ids.add(input[key])
  if (Array.isArray(input.ids))
    for (const id of input.ids) if (typeof id === "string") ids.add(id)
  if (isObject(input.expect) && isObject(input.expect.revs))
    for (const id of Object.keys(input.expect.revs)) ids.add(id)
  if (typeof input.x === "number" && typeof input.y === "number")
    points.push({ x: input.x, y: input.y })
  return { ids, points }
}

function conflictingClaim(
  st: BoardState,
  b: Board,
  agent: string,
  name: string,
  input: unknown,
): Claim | null {
  const others = liveClaims(st).filter((c) => c.agent !== agent)
  if (others.length === 0) return null
  const { ids, points } = touched(name, input)
  const pageId = typeof b.info.pageId === "string" ? b.info.pageId : undefined
  for (const c of others) {
    if (c.ids.some((id) => ids.has(id))) return c
    if (c.rect && (!c.rect.pageId || !pageId || c.rect.pageId === pageId)) {
      const r = c.rect
      if (
        points.some(
          (p) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h,
        )
      )
        return c
    }
  }
  return null
}

async function handleClaims(request: Request, url: URL): Promise<Response> {
  const rest = url.pathname.slice("/claims".length).replace(/^\//, "")
  if (request.method === "GET" && rest === "") {
    const picked = pickBoard(url.searchParams.get("board"))
    if ("response" in picked) return picked.response
    return json({
      board: picked.board.id,
      claims: liveClaims(stateOf(picked.board)),
    })
  }
  if (request.method === "DELETE" && rest) {
    const id = decodeURIComponent(rest)
    for (const st of states.values()) {
      if (st.claims.delete(id)) return json({ ok: true })
    }
    return json({ ok: false, error: `No claim ${id}.` }, 404)
  }
  if (request.method !== "POST" || rest)
    return json(
      { error: "Use GET /claims?board=, POST /claims or DELETE /claims/<id>." },
      404,
    )
  let body: Json
  try {
    const value = await request.json()
    if (!isObject(value)) throw new Error()
    body = value
  } catch {
    return json(
      {
        ok: false,
        error: "Body must be JSON: {board, agent, ids?, rect?, ttl?, note?}.",
      },
      400,
    )
  }
  const agent =
    typeof body.agent === "string" && body.agent ?
      body.agent
    : request.headers.get("x-agent")
  if (!agent) return json({ ok: false, error: "agent is required." }, 400)
  const ids =
    Array.isArray(body.ids) ?
      body.ids.filter((id): id is string => typeof id === "string")
    : []
  let rect: Claim["rect"] = null
  if (isObject(body.rect)) {
    const r = body.rect
    if (
      ![r.x, r.y, r.w, r.h].every(
        (n) => typeof n === "number" && Number.isFinite(n),
      )
    ) {
      return json({ ok: false, error: "rect needs numeric x, y, w, h." }, 400)
    }
    rect = {
      pageId: typeof r.pageId === "string" ? r.pageId : undefined,
      x: r.x as number,
      y: r.y as number,
      w: r.w as number,
      h: r.h as number,
    }
  }
  if (ids.length === 0 && !rect)
    return json({ ok: false, error: "Claim ids, a rect, or both." }, 400)
  const picked = pickBoard(body.board ?? url.searchParams.get("board"))
  if ("response" in picked) return picked.response
  const st = stateOf(picked.board)
  touchAgent(agent)
  for (const c of liveClaims(st)) {
    if (c.agent === agent) continue
    if (
      c.ids.some((id) => ids.includes(id))
      || (rect && c.rect && rectsOverlap(rect, c.rect))
    ) {
      return json(
        {
          ok: false,
          code: "claimed",
          error: `Claimed by ${c.agent}.`,
          claim: c,
        },
        409,
      )
    }
  }
  const ttl = Math.min(
    MAX_CLAIM_TTL,
    Math.max(1, Number(body.ttl ?? DEFAULT_CLAIM_TTL) || DEFAULT_CLAIM_TTL),
  )
  const now = Date.now()
  const claim: Claim = {
    id: `c${++seq}`,
    board: picked.board.id,
    agent,
    ids,
    rect,
    ttl,
    note: typeof body.note === "string" ? body.note : null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl * 1000).toISOString(),
  }
  st.claims.set(claim.id, claim)
  log(
    `${label(picked.board)} ${agent} claimed ${ids.length} id(s)${rect ? " + rect" : ""} for ${ttl}s (${claim.id})`,
  )
  return json({ ok: true, claim })
}

// Pick the board a request is for: by id, then file key, then exact file name
// (case-insensitive), then a unique name substring. With no selector, the only
// connected board.
function pickBoard(
  selector: unknown,
): { board: Board } | { response: Response } {
  const list = [...boards.values()]
  const choices = list.map((b) => summary(b))
  if (list.length === 0) {
    return {
      response: json(
        {
          ok: false,
          error:
            "No board connected. Turn on remote control in the plugin panel.",
          boards: [],
        },
        503,
      ),
    }
  }
  if (selector === undefined || selector === null || selector === "") {
    if (list.length === 1) return { board: list[0] }
    return {
      response: json(
        {
          ok: false,
          error: `${list.length} boards are connected; pass "board" (an id from "boards") to pick one.`,
          boards: choices,
        },
        409,
      ),
    }
  }
  const want = text(selector, JSON.stringify(selector))
  const lower = want.toLowerCase()
  const name = (b: Board) => text(b.info.name, "").toLowerCase()
  const tiers = [
    list.filter((b) => b.id === want),
    list.filter((b) => b.info.boardId === want),
    list.filter((b) => b.info.fileKey === want),
    list.filter((b) => name(b) === lower),
    list.filter((b) => name(b).includes(lower)),
  ]
  for (const matches of tiers) {
    if (matches.length === 1) return { board: matches[0] }
    if (matches.length > 1) {
      return {
        response: json(
          {
            ok: false,
            error: `"${want}" matches ${matches.length} boards; pass a board id.`,
            boards: matches.map((b) => summary(b)),
          },
          409,
        ),
      }
    }
  }
  return {
    response: json(
      {
        ok: false,
        error: `No connected board matches "${want}".`,
        boards: choices,
      },
      404,
    ),
  }
}

// Fetch image URLs for create_image (also inside batch) and pass base64 instead.
async function prefetchImages(name: unknown, input: unknown): Promise<void> {
  if (!isObject(input)) return
  if (name === "batch" && Array.isArray(input.calls)) {
    for (const call of input.calls)
      if (isObject(call)) await prefetchImages(call.name, call.input)
    return
  }
  if (name !== "create_image" || typeof input.url !== "string" || input.base64)
    return
  let res: Response
  try {
    res = await fetch(input.url, { signal: AbortSignal.timeout(20_000) })
  } catch (error) {
    throw new Error(
      `Couldn't fetch ${input.url}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!res.ok)
    throw new Error(`Fetching ${input.url} failed: HTTP ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.length > MAX_FETCH_BYTES)
    throw new Error(
      `${input.url} is ${bytes.length} bytes; the limit is ${MAX_FETCH_BYTES}.`,
    )
  // eslint-disable-next-line require-atomic-updates -- no shared state: `input` is one tool call's own parsed body.
  input.base64 = Buffer.from(bytes).toString("base64")
  if (!input.name)
    input.name = input.url.split("/").pop()?.split("?")[0] || "Image"
}

// Write every exported image in a result to <data>/figjam/exports/ and replace its base64
// with the file path (unless the caller asked for inline data).
async function persistImages(value: unknown, inline: boolean): Promise<void> {
  if (Array.isArray(value)) {
    for (const item of value) await persistImages(item, inline)
    return
  }
  if (!isObject(value)) return
  if (
    typeof value.base64 === "string"
    && (value.format === "PNG" || value.format === "JPG")
  ) {
    await mkdir(EXPORT_DIR, { recursive: true })
    const stamp = new Date()
      .toISOString()
      .replaceAll(/[-:]/g, "")
      .replace(/\..*$/, "")
      .replace("T", "-")
    const id = text(value.id, "image").replaceAll(/[^\w-]+/g, "-")
    const file = path.join(
      EXPORT_DIR,
      `${stamp}-${id}-${++seq}.${value.format === "JPG" ? "jpg" : "png"}`,
    )
    await Bun.write(file, Buffer.from(value.base64, "base64"))
    // eslint-disable-next-line require-atomic-updates -- no shared state: `value` is part of one tool call's result.
    value.path = file
    if (!inline) delete value.base64
    return
  }
  for (const key of Object.keys(value)) await persistImages(value[key], inline)
}

Bun.serve<SocketData>({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(request, server) {
    const url = new URL(request.url)
    const origin = request.headers.get("origin")

    if (url.pathname === "/plugin") {
      // The plugin iframe's origin is `null`; the hello's pairing token is
      // what actually authenticates the socket.
      if (origin !== null && origin !== "null") {
        log(`refused plugin socket from origin ${origin}`)
        return new Response("forbidden", { status: 403 })
      }
      return server.upgrade(request, { data: {} }) ? undefined : (
          new Response("upgrade failed", { status: 400 })
        )
    }

    // The HTTP API is for CLIs and agents only: no browser, and the token.
    if (origin !== null)
      return json({ error: "Browser requests are not accepted." }, 403)
    const authed = tokenMatches(bearer(request))
    if (url.pathname === "/status" && request.method === "GET" && !authed) {
      return json({ ok: true, version: BRIDGE_VERSION, paired: false })
    }
    if (!authed) {
      return json(
        {
          error: `Unauthorized: send Authorization: Bearer <token> (the bridge admin token: the figjam CLI sends it; it's in ${pairingTokenPath()}).`,
        },
        401,
      )
    }

    if (url.pathname === "/chats" || url.pathname.startsWith("/chats/"))
      return handleChats(request, url)
    if (url.pathname === "/pair" || url.pathname.startsWith("/pair/"))
      return handlePair(request, url)

    if (url.pathname === "/status" && request.method === "GET") {
      return json({
        ok: true,
        paired: true,
        connected: boards.size > 0,
        boards: [...boards.values()].map((b) => summary(b)),
        inFlight: pending.size,
        pairing: { pending: pairRequests.size, clients: clients.length },
        bridge: {
          version: BRIDGE_VERSION,
          port: PORT,
          exports: EXPORT_DIR,
          chats: chats.path,
        },
      })
    }

    if (url.pathname === "/tools" && request.method === "GET") {
      // Every board runs the same plugin, so without a selector any board's
      // list will do.
      const selector = url.searchParams.get("board")
      const first = boards.values().next().value
      let picked: ReturnType<typeof pickBoard> | undefined
      if (selector) picked = pickBoard(selector)
      else if (first) picked = { board: first }
      if (picked && "response" in picked) return picked.response
      const b = picked?.board
      return json({
        connected: boards.size > 0,
        board: b ? b.id : null,
        plugin: b?.plugin ?? null,
        tools: b?.tools ?? [],
      })
    }

    if (url.pathname === "/changes" && request.method === "GET")
      return handleChanges(url)
    if (url.pathname === "/claims" || url.pathname.startsWith("/claims/"))
      return handleClaims(request, url)

    if (url.pathname === "/tool" && request.method === "POST") {
      let body: {
        name?: unknown
        input?: unknown
        inline?: unknown
        board?: unknown
        agent?: unknown
      }
      try {
        body = (await request.json()) as typeof body
      } catch {
        return json(
          {
            ok: false,
            error: "Body must be JSON: {name, input, board?, agent?}.",
          },
          400,
        )
      }
      if (typeof body.name !== "string")
        return json({ ok: false, error: "name is required." }, 400)
      const name = body.name
      const agent =
        (typeof body.agent === "string" && body.agent)
        || request.headers.get("x-agent")
        || "anonymous"
      touchAgent(agent)
      const picked = pickBoard(body.board ?? url.searchParams.get("board"))
      if ("response" in picked) return picked.response
      const input = body.input ?? {}
      try {
        await prefetchImages(name, input)
      } catch (error) {
        return json(
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          502,
        )
      }
      const target = picked.board
      const forward = (): Promise<Response> => {
        if (boards.get(target.id) !== target)
          return Promise.resolve(
            json({ ok: false, error: `Board ${target.id} disconnected.` }, 503),
          )
        const id = `r${++seq}`
        return new Promise<Response>((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(id)
            resolve(
              json(
                {
                  ok: false,
                  error: `No answer from board ${target.id} within ${TIMEOUT_MS / 1000}s.`,
                },
                504,
              ),
            )
          }, TIMEOUT_MS)
          pending.set(id, {
            resolve,
            timer,
            name,
            started: Date.now(),
            inline: body.inline === true,
            board: target,
          })
          target.ws.send(
            JSON.stringify({
              type: "tool",
              id,
              name,
              input,
              actor: `agent:${agent}`,
            }),
          )
        })
      }
      if (READ_TOOL.test(name)) return forward()
      // Writes: refuse ids another agent has claimed, then run one at a time
      // per board, in arrival order.
      const st = stateOf(target)
      const claim = conflictingClaim(st, target, agent, name, input)
      if (claim)
        return json(
          {
            ok: false,
            code: "claimed",
            error: `Claimed by ${claim.agent}.`,
            claim,
          },
          409,
        )
      const previous = st.writeTail
      let release!: () => void
      st.writeTail = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous
      try {
        // A claim may have landed while this call waited its turn.
        const late = conflictingClaim(st, target, agent, name, input)
        if (late)
          return json(
            {
              ok: false,
              code: "claimed",
              error: `Claimed by ${late.agent}.`,
              claim: late,
            },
            409,
          )
        return await forward()
      } finally {
        release()
      }
    }

    return json(
      {
        error:
          "Not found. Use GET /status, GET /tools, POST /tool, GET /changes, /claims, /chats or /pair.",
      },
      404,
    )
  },
  websocket: {
    maxPayloadLength: 64 * 1024 * 1024,
    open() {
      log("plugin socket opened; waiting for hello")
    },
    async message(ws: ServerWebSocket<SocketData>, raw) {
      let msg: SocketMessage
      try {
        msg = JSON.parse(String(raw)) as SocketMessage
      } catch {
        return
      }
      if (msg.type === "hello") {
        // A re-hello starts over: drop this socket's board or pending request.
        const had = ws.data.id ? boards.get(ws.data.id) : undefined
        if (had && had.ws === ws) {
          boards.delete(had.id)
          failPending(had, "The board said hello again.")
        }
        ws.data.id = undefined
        const client = clientForToken(msg.token)
        if (!client) {
          // Not an error: an unknown or revoked token is just a new request.
          startPairRequest(ws, msg, msg.token ? "unknown-token" : "no-token")
          return
        }
        const own =
          ws.data.pairId ? pairRequests.get(ws.data.pairId) : undefined
        if (own) dropPairRequest(own)
        client.lastSeen = new Date().toISOString()
        saveClients()
        ws.send(
          JSON.stringify({
            type: "paired",
            version: BRIDGE_VERSION,
            clientId: client.id,
          }),
        )
        admit(ws, msg, client)
        return
      }
      // Pending or unpaired sockets get nothing but pairing messages.
      const b = ws.data.id ? boards.get(ws.data.id) : undefined
      if (!b || b.ws !== ws) return
      if (msg.type === "unpair") {
        // The panel's "Forget": revoke its token and close.
        forgetClient(b.clientId)
        return
      }
      if (msg.type === "chats") {
        ws.send(
          JSON.stringify({
            type: "chats-reply",
            reqId: msg.reqId,
            ...chatOp(msg),
          }),
        )
        return
      }
      if (msg.type === "board" && isObject(msg.board)) {
        b.info = msg.board
        log(`${label(b)} now on page ${text(b.info.page, "?")}`)
        return
      }
      if (msg.type === "changes") {
        recordChanges(b, msg)
        return
      }
      if (msg.type === "tool-result" && msg.id) {
        const entry = pending.get(msg.id)
        if (!entry || entry.board !== b) return
        pending.delete(msg.id)
        clearTimeout(entry.timer)
        log(
          `${label(b)} ${msg.ok ? "ok " : "err"} ${entry.name} (${Date.now() - entry.started} ms)`,
        )
        if (msg.ok) {
          try {
            await persistImages(msg.result, entry.inline)
          } catch (error) {
            log(
              `couldn't save export: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
        entry.resolve(
          json(
            msg.ok ?
              { ok: true, board: b.id, result: msg.result }
            : { ok: false, board: b.id, error: msg.error },
          ),
        )
      }
    },
    close(ws: ServerWebSocket<SocketData>) {
      const request =
        ws.data.pairId ? pairRequests.get(ws.data.pairId) : undefined
      if (request && request.ws === ws) {
        dropPairRequest(request)
        log(`pairing request ${request.name} withdrawn (socket closed)`)
      }
      const b = ws.data.id ? boards.get(ws.data.id) : undefined
      if (!b || b.ws !== ws) return
      boards.delete(b.id)
      failPending(b, `Board ${b.id} disconnected.`)
      log(`${label(b)} disconnected · ${boards.size} board(s)`)
    },
  },
})

// Chat storage for the paired panel socket: {type:"chats", op, reqId, ...}
// answers with the same shapes as the HTTP API, plus ok (and error).
function chatOp(msg: Json): Json {
  const boardId =
    typeof msg.boardId === "string" && msg.boardId ? msg.boardId : null
  const id = typeof msg.id === "string" ? msg.id : ""
  try {
    switch (msg.op) {
      case "list": {
        return { ok: true, chats: chats.list(boardId) }
      }
      case "search": {
        return {
          ok: true,
          results: chats.search(
            typeof msg.q === "string" ? msg.q : "",
            boardId,
          ),
        }
      }
      case "get": {
        const chat = chats.get(id)
        return chat ?
            { ok: true, chat }
          : { ok: false, status: 404, error: `No chat ${id}.` }
      }
      case "put": {
        const chat = isObject(msg.chat) ? msg.chat : null
        if (!id || !chat)
          return { ok: false, status: 400, error: "put needs {id, chat}." }
        if (chat.id !== undefined && chat.id !== id)
          return { ok: false, status: 400, error: "chat.id doesn't match id." }
        return { ok: true, chat: chats.upsert(id, chat) }
      }
      case "rename": {
        if (!id || typeof msg.title !== "string")
          return { ok: false, status: 400, error: "rename needs {id, title}." }
        const entry = chats.rename(id, msg.title)
        return entry ?
            { ok: true, chat: entry }
          : { ok: false, status: 404, error: `No chat ${id}.` }
      }
      case "delete": {
        if (!id) return { ok: false, status: 400, error: "delete needs {id}." }
        chats.delete(id)
        return { ok: true }
      }
      default: {
        return {
          ok: false,
          status: 400,
          error: `Unknown chats op ${String(msg.op)}.`,
        }
      }
    }
  } catch (error) {
    if (error instanceof StoreError)
      return { ok: false, status: error.status, error: error.message }
    log(
      `chat store error: ${error instanceof Error ? error.message : String(error)}`,
    )
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function handleChats(request: Request, url: URL): Promise<Response> {
  const method = request.method
  const rest = url.pathname.slice("/chats".length).replace(/^\//, "")
  const boardId = url.searchParams.get("boardId") || null
  const body = async (): Promise<Json> => {
    let value: unknown
    try {
      value = await request.json()
    } catch {
      throw new StoreError("Body must be JSON.", 400)
    }
    if (!isObject(value))
      throw new StoreError("Body must be a JSON object.", 400)
    return value
  }
  try {
    if (rest === "" && method === "GET")
      return json({ chats: chats.list(boardId) })
    if (rest === "search" && method === "GET")
      return json({
        results: chats.search(url.searchParams.get("q") ?? "", boardId),
      })
    if (rest === "" || rest.includes("/"))
      return json({ error: "Not found." }, 404)
    const id = decodeURIComponent(rest)
    if (method === "GET") {
      const chat = chats.get(id)
      return chat ? json({ chat }) : json({ error: `No chat ${id}.` }, 404)
    }
    if (method === "PUT") {
      const b = await body()
      const chat = isObject(b.chat) ? b.chat : null
      if (!chat) return json({ error: "Body must be {chat}." }, 400)
      if (chat.id !== undefined && chat.id !== id)
        return json({ error: "chat.id doesn't match the URL." }, 400)
      return json({ chat: chats.upsert(id, chat) })
    }
    if (method === "PATCH") {
      const b = await body()
      if (typeof b.title !== "string")
        return json({ error: "Body must be {title}." }, 400)
      const entry = chats.rename(id, b.title)
      return entry ?
          json({ chat: entry })
        : json({ error: `No chat ${id}.` }, 404)
    }
    if (method === "DELETE") {
      chats.delete(id)
      return json({ ok: true })
    }
    return json({ error: `${method} isn't supported here.` }, 405)
  } catch (error) {
    if (error instanceof StoreError)
      return json({ error: error.message }, error.status)
    log(
      `chat store error: ${error instanceof Error ? error.message : String(error)}`,
    )
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      500,
    )
  }
}

function failPending(b: Board, error: string): void {
  for (const [id, entry] of pending) {
    if (entry.board !== b) continue
    clearTimeout(entry.timer)
    entry.resolve(json({ ok: false, board: b.id, error }, 503))
    pending.delete(id)
  }
}

log(
  `FigJam bridge v${BRIDGE_VERSION} on http://127.0.0.1:${PORT} (plugin socket: ws://localhost:${PORT}/plugin)`,
)
log(`chats: ${chats.path}`)
log(
  `bridge admin token (HTTP/CLI only): ${pairingTokenPath()} · paired panels: ${clientsPath()} (${clients.length})`,
)
