/**
 * Chat persistence for the FigJam bridge: SQLite (bun:sqlite, WAL) with an
 * FTS5 index over each chat's title and the plain text of its messages.
 *
 * DB: <data>/figjam/chats.sqlite (see data-dir.ts for <data>).
 */
import { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

import { dataDir, pairingTokenPath } from "./data-dir"

type Json = Record<string, unknown>

export interface IndexEntry {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  model: string | null
  effort: string | null
  turns: number
  boardId: string
  boardName: string | null
}

export interface SearchResult extends IndexEntry {
  snippet: string
}

const MAX_CHARS = 800_000
const TRUNCATE_TO = 2_000

export function defaultDbPath(): string {
  return path.join(dataDir(), "figjam", "chats.sqlite")
}

export function loadPairingToken({
  rotate = false,
  create = true,
} = {}): string {
  const file = pairingTokenPath()
  if (!rotate && existsSync(file)) {
    const token = readFileSync(file, "utf8").trim()
    if (token) return token
  }
  if (!create) return ""
  mkdirSync(path.dirname(file), { recursive: true })
  const token = randomBytes(32).toString("base64url")
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  return token
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Replace image blocks (also inside tool_result.content) with a text marker.
function stripImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripImages(item))
  if (!isObject(value)) return value
  if (value.type === "image") return { type: "text", text: "[image not saved]" }
  const out: Json = {}
  for (const [k, v] of Object.entries(value)) out[k] = stripImages(v)
  return out
}

// Over the cap: shorten long text in tool_result blocks, oldest first.
function capMessages(messages: Array<unknown>): Array<unknown> {
  let size = JSON.stringify(messages).length
  if (size <= MAX_CHARS) return messages
  const shorten = (text: string): string => {
    if (text.length <= TRUNCATE_TO) return text
    const next = text.slice(0, TRUNCATE_TO) + "…[truncated]"
    size -= text.length - next.length
    return next
  }
  for (const msg of messages) {
    if (!isObject(msg) || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (size <= MAX_CHARS) return messages
      if (!isObject(block) || block.type !== "tool_result") continue
      if (typeof block.content === "string") {
        block.content = shorten(block.content)
        continue
      }
      if (!Array.isArray(block.content)) continue
      for (const inner of block.content) {
        if (isObject(inner) && typeof inner.text === "string")
          inner.text = shorten(inner.text)
      }
    }
  }
  return messages
}

function countTurns(messages: Array<unknown>): number {
  let n = 0
  for (const m of messages) {
    if (!isObject(m) || m.role !== "user") continue
    if (typeof m.content === "string") n++
    else if (
      Array.isArray(m.content)
      && m.content.some((b) => isObject(b) && b.type === "text")
    )
      n++
  }
  return n
}

// Plain text for the search index: user/assistant text, tool_use name + input,
// tool_result text. Images are skipped.
function extractText(messages: Array<unknown>): string {
  const parts: Array<string> = []
  const block = (b: unknown): void => {
    if (typeof b === "string") {
      parts.push(b)
      return
    }
    if (!isObject(b)) return
    if (
      b.type === "text"
      && typeof b.text === "string"
      && b.text !== "[image not saved]"
    )
      parts.push(b.text)
    else if (b.type === "tool_use")
      parts.push(
        `${typeof b.name === "string" ? b.name : ""} ${JSON.stringify(b.input ?? {})}`,
      )
    else if (b.type === "tool_result") {
      if (typeof b.content === "string") parts.push(b.content)
      else if (Array.isArray(b.content)) for (const c of b.content) block(c)
    }
  }
  for (const m of messages) {
    if (!isObject(m)) continue
    if (Array.isArray(m.content)) for (const c of m.content) block(c)
    else block(m.content)
  }
  return parts.join("\n")
}

// Turn arbitrary user input into a safe FTS5 query: each token quoted, the
// last one a prefix match. Returns null when nothing searchable is left.
export function toFtsQuery(input: string): string | null {
  const tokens = input
    .split(/\s+/)
    .map((t) => t.replaceAll('"', ""))
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
  if (tokens.length === 0) return null
  return tokens
    .map((t, i) => `"${t}"${i === tokens.length - 1 ? "*" : ""}`)
    .join(" ")
}

const escapeHtml = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

interface Row {
  id: string
  board_id: string
  board_name: string | null
  title: string
  created_at: string
  updated_at: string
  model: string | null
  effort: string | null
  turns: number
  messages?: string
  snippet?: string
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v ? v : null

const INDEX_COLS =
  "c.id, c.board_id, c.board_name, c.title, c.created_at, c.updated_at, c.model, c.effort, c.turns"

function toEntry(r: Row): IndexEntry {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    model: r.model,
    effort: r.effort,
    turns: r.turns,
    boardId: r.board_id,
    boardName: r.board_name,
  }
}

export class ChatStore {
  readonly path: string
  private db: Database

  constructor(file = defaultDbPath()) {
    this.path = file
    mkdirSync(path.dirname(file), { recursive: true })
    this.db = new Database(file, { create: true })
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run("PRAGMA busy_timeout = 3000")
    this.db.run(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL,
        board_name TEXT,
        title TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        turns INTEGER NOT NULL DEFAULT 0,
        messages TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS chats_board_updated ON chats(board_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS chats_updated ON chats(updated_at DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS chats_fts USING fts5(chat_id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');
    `)
  }

  list(boardId?: string | null): Array<IndexEntry> {
    const rows =
      boardId ?
        this.db
          .query<
            Row,
            [string]
          >(`SELECT ${INDEX_COLS} FROM chats c WHERE c.board_id = ? ORDER BY c.updated_at DESC`)
          .all(boardId)
      : this.db
          .query<
            Row,
            []
          >(`SELECT ${INDEX_COLS} FROM chats c ORDER BY c.updated_at DESC`)
          .all()
    return rows.map((r) => toEntry(r))
  }

  get(id: string): Json | null {
    const r = this.db
      .query<
        Row,
        [string]
      >(`SELECT ${INDEX_COLS}, c.messages FROM chats c WHERE c.id = ?`)
      .get(id)
    if (!r) return null
    let messages: unknown = []
    try {
      messages = JSON.parse(r.messages ?? "[]")
    } catch {
      // Unreadable messages column: return the chat with no messages.
    }
    return { ...toEntry(r), messages }
  }

  private entry(id: string): IndexEntry | null {
    const r = this.db
      .query<Row, [string]>(`SELECT ${INDEX_COLS} FROM chats c WHERE c.id = ?`)
      .get(id)
    return r ? toEntry(r) : null
  }

  upsert(id: string, chat: Json): IndexEntry {
    const boardId =
      typeof chat.boardId === "string" && chat.boardId ? chat.boardId : null
    if (!boardId) throw new StoreError("chat.boardId is required.", 400)
    if (chat.messages !== undefined && !Array.isArray(chat.messages))
      throw new StoreError("chat.messages must be an array.", 400)
    const messages = capMessages(
      stripImages(chat.messages ?? []) as Array<unknown>,
    )
    const now = new Date().toISOString()
    const existing = this.db
      .query<
        { created_at: string },
        [string]
      >("SELECT created_at FROM chats WHERE id = ?")
      .get(id)
    const createdAt =
      typeof chat.createdAt === "string" && chat.createdAt ?
        chat.createdAt
      : (existing?.created_at ?? now)
    const title = typeof chat.title === "string" ? chat.title : ""
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO chats (id, board_id, board_name, title, created_at, updated_at, model, effort, turns, messages)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET board_id = excluded.board_id, board_name = excluded.board_name,
             title = excluded.title, created_at = excluded.created_at, updated_at = excluded.updated_at,
             model = excluded.model, effort = excluded.effort, turns = excluded.turns, messages = excluded.messages`,
        )
        .run(
          id,
          boardId,
          str(chat.boardName),
          title,
          createdAt,
          now,
          str(chat.model),
          str(chat.effort),
          countTurns(messages),
          JSON.stringify(messages),
        )
      this.db.query("DELETE FROM chats_fts WHERE chat_id = ?").run(id)
      this.db
        .query("INSERT INTO chats_fts (chat_id, title, body) VALUES (?, ?, ?)")
        .run(id, title, extractText(messages))
    })()
    const entry = this.entry(id)
    if (!entry) throw new StoreError(`Chat ${id} wasn't saved.`, 500)
    return entry
  }

  rename(id: string, title: string): IndexEntry | null {
    const found = this.db.transaction((): boolean => {
      const res = this.db
        .query("UPDATE chats SET title = ? WHERE id = ?")
        .run(title, id)
      if (res.changes === 0) return false
      this.db
        .query("UPDATE chats_fts SET title = ? WHERE chat_id = ?")
        .run(title, id)
      return true
    })()
    return found ? this.entry(id) : null
  }

  delete(id: string): boolean {
    return this.db.transaction((): boolean => {
      const found =
        this.db.query("DELETE FROM chats WHERE id = ?").run(id).changes > 0
      this.db.query("DELETE FROM chats_fts WHERE chat_id = ?").run(id)
      return found
    })()
  }

  search(q: string, boardId?: string | null, limit = 50): Array<SearchResult> {
    const match = toFtsQuery(q)
    if (!match) return []
    // \u0001/\u0002 mark hits so the snippet can be HTML-escaped before <mark> goes in.
    const sql = `SELECT ${INDEX_COLS}, snippet(chats_fts, -1, char(1), char(2), '…', 12) AS snippet
      FROM chats_fts f JOIN chats c ON c.id = f.chat_id
      WHERE chats_fts MATCH ? ${boardId ? "AND c.board_id = ?" : ""}
      ORDER BY bm25(chats_fts, 0, 5.0, 1.0), c.updated_at DESC LIMIT ?`
    let rows: Array<Row>
    try {
      const params = boardId ? [match, boardId, limit] : [match, limit]
      rows = this.db.query<Row, Array<string | number>>(sql).all(...params)
    } catch {
      return []
    }
    return rows.map((r) => ({
      ...toEntry(r),
      snippet: escapeHtml(r.snippet ?? "")
        .replaceAll("\u0001", "<mark>")
        .replaceAll("\u0002", "</mark>"),
    }))
  }

  close(): void {
    this.db.close()
  }
}

export class StoreError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export { dataDir, pairingTokenPath } from "./data-dir"
