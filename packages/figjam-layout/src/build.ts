// Build a planned Layout on the board.
//   build(L, pageId?)       recreate sections + cards on "Map — layout experiment" (a page we own), then edges.
//                           Re-runs reuse the same sections/cards (stable clientIds) and replace the edges.
//   overlay(L, {pageId, tree}) put the planned edges over an existing map, reversibly: hide the existing
//                           connectors (visible:false, expect.revs) and add new edges in one group
//                           "Routed edges". Revert: delete the group, show the connectors again.
import type { BoardTree } from "./cli"

import { tool as callTool } from "./client"
import { HARD_CHECKS } from "./lanes"
import {
  last,
  must,
  type Edge,
  type EdgeKind,
  type Layout,
  type Piece,
  type Pt,
  type Rect,
  type Route,
} from "./model"
import { bridgeToken } from "./token"

// The bridge call every tool request goes through, with the operator's opt-in token (token.ts).
const tool = (name: string, input: Record<string, unknown>) =>
  callTool(name, input, { token: bridgeToken() })

type StrokeStyle = {
  color: string
  strokeWeight: number
  dashPattern?: Array<number>
  endCap: string
}
const EDGE_STYLE: Record<EdgeKind, StrokeStyle> = {
  dep: { color: "black", strokeWeight: 2, endCap: "ARROW_LINES" },
  flow: {
    color: "gray",
    strokeWeight: 2,
    dashPattern: [10, 6],
    endCap: "ARROW_EQUILATERAL",
  },
  verify: {
    color: "gray",
    strokeWeight: 2,
    dashPattern: [2, 6],
    endCap: "CIRCLE_FILLED",
  },
  loop: { color: "black", strokeWeight: 6, endCap: "TRIANGLE_FILLED" },
  other: { color: "black", strokeWeight: 2, endCap: "ARROW_LINES" },
}
const isEdgeKind = (k: string | undefined): k is EdgeKind =>
  k !== undefined && Object.hasOwn(EDGE_STYLE, k)
const styleFor = (kind: string | undefined) =>
  isEdgeKind(kind) ? EDGE_STYLE[kind] : EDGE_STYLE.other

// ---- tool results: the bridge's JSON is narrowed here, not trusted ----

type Json = Record<string, unknown>
type Call = { name: string; input: Json }
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null
// JSON from the bridge: only `undefined` has no JSON text
const brief = (v: unknown, n = 400): string =>
  v === undefined ? "undefined" : JSON.stringify(v).slice(0, n)
function record(v: unknown, what: string): Json {
  if (!isRecord(v))
    throw new Error(`${what}: expected an object, got ${brief(v)}`)
  return v
}
function array(v: unknown, what: string): Array<unknown> {
  if (!Array.isArray(v))
    throw new Error(`${what}: expected a list, got ${brief(v)}`)
  return v
}
function idOf(v: unknown, what: string): string {
  const id = record(v, what).id
  if (typeof id !== "string") throw new Error(`${what}: no id in ${brief(v)}`)
  return id
}
// `ids` of a draw: optional, a list of strings when present
function idList(v: unknown, what: string): Array<string> {
  if (v === undefined) return []
  return array(v, what).map((x) => {
    if (typeof x !== "string")
      throw new Error(`${what}: not an id: ${brief(x)}`)
    return x
  })
}

// one arrowhead size everywhere: 14px long, 12px wide, tip exactly on the card border
export const ARROW = { len: 14, half: 6 }
function arrowhead(pts: Array<Pt>): Array<Pt> {
  const [a, b] = [must(pts.at(-2), "arrowhead base"), last(pts)]
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  const ux = (b[0] - a[0]) / len,
    uy = (b[1] - a[1]) / len
  const { len: L, half: H } = ARROW
  return [
    [b[0] - ux * L - uy * H, b[1] - uy * L + ux * H],
    b,
    [b[0] - ux * L + uy * H, b[1] - uy * L - ux * H],
  ]
}

// a small filled dot (radius 4 + 6px stroke) whose edge touches the card border
function dot(pts: Array<Pt>): Array<Pt> {
  const [a, b] = [must(pts.at(-2), "dot base"), last(pts)]
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  const ux = (b[0] - a[0]) / len,
    uy = (b[1] - a[1]) / len
  const cx = b[0] - ux * 7,
    cy = b[1] - uy * 7
  return Array.from(
    { length: 8 },
    (_, i): Pt => [
      cx + 3 * Math.cos((i * Math.PI) / 4),
      cy + 3 * Math.sin((i * Math.PI) / 4),
    ],
  )
}

async function batch(calls: Array<Call>, size = 25): Promise<Array<unknown>> {
  const out: Array<unknown> = []
  for (let i = 0; i < calls.length; i += size) {
    const r = record(
      await tool("batch", {
        calls: calls.slice(i, i + size),
        stopOnError: true,
      }),
      "batch",
    )
    for (const item of array(r.results, "batch results")) {
      const x = record(item, "batch result")
      if (!x.ok) throw new Error(`${String(x.name)}: ${brief(x)}`)
      out.push(x.result)
    }
  }
  return out
}

// Where drawEdges writes: the page, our card ids by layout id, and the clientId prefix.
type Target = { page: string; ids: Map<string, string>; tag: string }

// Edges: native connectors (planned magnets) + drawn pieces. Returns the ids of everything made.
export let truncatedBefore = 0 // pills whose text came out wider than planned (grown to fit)
async function drawEdges(L: Layout, t: Target): Promise<Array<string>> {
  const edge = new Map(L.edges.map((e) => [e.id, e]))
  const edgeOf = (id: string) => must(edge.get(id), `edge ${id}`)
  // native connectors live inside sections, so they can't join the group
  const made = await drawNative(L, t, edgeOf)
  // page-level vectors + labels → one group
  const loose = [
    ...(await drawPieces(L, t, edgeOf)),
    ...(await drawPills(L, t)),
  ]
  if (loose.length > 0) loose.push(await groupAll(t.page, loose))
  return [...made, ...loose]
}

async function drawNative(
  L: Layout,
  t: Target,
  edgeOf: (id: string) => Edge,
): Promise<Array<string>> {
  const made: Array<string> = []
  const byKind = new Map<EdgeKind, Array<Route>>()
  for (const r of L.routes.filter((x) => x.native)) {
    const k = edgeOf(r.edge).kind
    byKind.set(k, [...(byKind.get(k) ?? []), r])
  }
  for (const [k, rs] of byKind) {
    for (let i = 0; i < rs.length; i += 25) {
      const connections = rs.slice(i, i + 25).map((r) => {
        const e = edgeOf(r.edge)
        return {
          from: t.ids.get(e.from) ?? e.from,
          to: t.ids.get(e.to) ?? e.to,
          startMagnet: r.fromMagnet,
          endMagnet: r.toMagnet,
          ...(e.label ? { label: e.label } : {}),
        }
      })
      const res = record(
        await tool("connect", {
          pageId: t.page,
          ...EDGE_STYLE[k],
          lineType: "ELBOWED",
          connections,
          clientId: `layout.${t.tag}.conn.${k}.${i}`,
        }),
        "connect",
      )
      const created =
        res.created === undefined ?
          [res]
        : array(res.created, "connect.created")
      made.push(...created.map((c) => idOf(c, "connect")))
    }
  }
  return made
}

type Stroke = {
  points: Array<Pt>
  smooth: boolean
  closed?: boolean
  color: string
  width: number
}
type DrawPiece = Pick<Piece, "pts" | "kind" | "arrow" | "arrowOnly">

// a piece's line (unless it is only an arrowhead), then its arrowhead or dot
function strokesOf(
  pc: DrawPiece,
): Array<{ stroke: Stroke; dash?: Array<number> }> {
  const st = styleFor(pc.kind)
  const out: Array<{ stroke: Stroke; dash?: Array<number> }> = []
  if (!pc.arrowOnly)
    out.push({
      stroke: {
        points: pc.pts,
        smooth: false,
        color: st.color,
        width: st.strokeWeight,
      },
      dash: st.dashPattern,
    })
  if (!pc.arrow && !pc.arrowOnly) return out
  // legend: "checks the result" ends in a dot
  out.push(
    pc.kind === "verify" ?
      {
        stroke: {
          points: dot(pc.pts),
          smooth: true,
          closed: true,
          color: st.color,
          width: 6,
        },
      }
    : {
        stroke: {
          points: arrowhead(pc.pts),
          smooth: false,
          color: st.color,
          width: Math.min(st.strokeWeight, 3),
        },
      },
  )
  return out
}

// drawn pieces: bundle chains (each drawn once, so dashes stay continuous) and arrowheads
async function drawPieces(
  L: Layout,
  t: Target,
  edgeOf: (id: string) => Edge,
): Promise<Array<string>> {
  const pieces: Array<DrawPiece> =
    L.pieces
    ?? L.routes
      .filter((r) => !r.native)
      .map((r) => ({ pts: r.pts, kind: edgeOf(r.edge).kind, arrow: true }))
  const strokes = pieces.flatMap((pc) => strokesOf(pc))
  const loose: Array<string> = []
  for (let i = 0; i < strokes.length; i += 40) {
    const chunk = strokes.slice(i, i + 40)
    const res = record(
      await tool("draw", {
        pageId: t.page,
        strokes: chunk.map((c) => c.stroke),
        name: "Routed edge",
        clientId: `layout.${t.tag}.route.${i}`,
      }),
      "draw",
    )
    const got = idList(res.ids, "draw.ids")
    loose.push(...got)
    const dashed = chunk.flatMap(
      (c, j): Array<Call> =>
        c.dash && got[j] ?
          [
            {
              name: "update_node",
              input: { pageId: t.page, id: got[j], dashPattern: c.dash },
            },
          ]
        : [],
    )
    if (dashed.length > 0) await batch(dashed)
  }
  return loose
}

// labels and name-tag pills: a pill background, then auto-width text on top (auto-width text can't
// truncate); the pill grows if the text came out wider than planned (counted in `truncatedBefore`)
type Pill = { text: string; rect: Rect; kind: "label" | "tag"; link?: string }
async function drawPills(L: Layout, t: Target): Promise<Array<string>> {
  const pills: Array<Pill> = [
    ...(L.labels ?? []).map((l) => ({
      text: l.text,
      rect: l.rect,
      kind: "label" as const,
    })),
    ...(L.tags ?? []).map((g) => ({
      text: g.text,
      rect: g.rect,
      kind: "tag" as const,
      link: t.ids.get(g.other) ?? g.other,
    })),
  ]
  const bgs = (
    await batch(
      pills.map((p, i) => ({
        name: "create_shape",
        input: {
          pageId: t.page,
          shape: "ROUNDED_RECTANGLE",
          x: p.rect.x,
          y: p.rect.y,
          width: p.rect.w,
          height: p.rect.h,
          fill: "#FFFFFF",
          ...(p.kind === "tag" ?
            { stroke: "#9747FF", strokeWeight: 1 }
          : { strokeMode: "none" }),
          clientId: `layout.${t.tag}.pillbg.${i}`,
        },
      })),
    )
  ).map((r) => idOf(r, "create_shape"))
  const txts = (
    await batch(
      pills.map((p, i) => ({
        name: "create_text",
        input: {
          pageId: t.page,
          text: p.text,
          x: p.rect.x + 12,
          y: p.rect.y + Math.round((p.rect.h - 20) / 2),
          textStyle: "caption",
          color: p.kind === "tag" ? "#5B2BC4" : "#5E5E5E",
          clientId: `layout.${t.tag}.pilltext.${i}`,
        },
      })),
    )
  ).map((r) => ({
    id: idOf(r, "create_text"),
    width: Number(record(r, "create_text").width ?? 0),
  }))
  const grow: Array<Call> = []
  for (const [i, x] of txts.entries()) {
    if (x.width + 24 > pills[i].rect.w) {
      truncatedBefore++
      grow.push({
        name: "update_node",
        input: { pageId: t.page, id: bgs[i], width: Math.ceil(x.width + 24) },
      })
    }
  }
  if (grow.length > 0) await batch(grow)
  const links = pills.flatMap(
    (p, i): Array<Call> =>
      p.link ?
        [
          {
            name: "set_link",
            input: { pageId: t.page, id: txts[i].id, nodeId: p.link },
          },
        ]
      : [],
  )
  if (links.length > 0) await batch(links)
  return [...bgs, ...txts.map((x) => x.id)]
}

// group takes ≤ 200 ids: group in parts, then group the parts. Returns the outer group's id.
async function groupAll(page: string, ids: Array<string>): Promise<string> {
  let parts = ids.slice()
  while (parts.length > 200) {
    const next: Array<string> = []
    for (let i = 0; i < parts.length; i += 200)
      next.push(
        idOf(
          await tool("group", {
            pageId: page,
            ids: parts.slice(i, i + 200),
            name: "Routed edges (part)",
          }),
          "group",
        ),
      )
    parts = next
  }
  return idOf(
    await tool("group", { pageId: page, ids: parts, name: "Routed edges" }),
    "group",
  )
}

export function gate(L: Layout) {
  const ck = L.checks ?? {}
  const bad = HARD_CHECKS.filter((k) => (ck[k] ?? 0) > 0)
  if (bad.length > 0 && !process.env.LAYOUT_FORCE)
    throw new Error(
      `self-checks failed: ${bad.map((k) => `${k}=${ck[k]}`).join(", ")}`,
    )
}

const OUR_PAGE = "Map — layout experiment"

// Refuses unless `page` is our experiment page.
async function checkOurPage(page: string) {
  const pages = await tool("list_pages", {})
  const all: Array<unknown> =
    Array.isArray(pages) ? pages : (
      array(record(pages, "list_pages").pages ?? [], "pages")
    )
  const pg = all.find((p) => isRecord(p) && p.id === page)
  const name = isRecord(pg) ? pg.name : undefined
  if (name !== OUR_PAGE)
    throw new Error(
      `refusing to build on ${page} (${String(name)}): not our experiment page`,
    )
}

// clear edges from earlier runs on our own page
async function clearEdges(page: string) {
  for (const types of [["GROUP"], ["CONNECTOR", "VECTOR", "TEXT"]]) {
    const old = record(
      await tool("find_nodes", { pageId: page, types, limit: 500 }),
      "find_nodes",
    )
    const oldIds = array(old.nodes ?? [], "find_nodes.nodes")
      .map((n) => record(n, "find_nodes node"))
      .filter(
        (n) =>
          types[0] !== "GROUP" || String(n.name).startsWith("Routed edges"),
      )
      .filter((n) => !n.groupId)
      .map((n) => idOf(n, "find_nodes node"))
    if (oldIds.length > 0)
      await tool("delete_nodes", { pageId: page, ids: oldIds, confirm: true })
  }
}

// sections, then the cards inside them; returns our id for each layout id
async function drawCards(
  L: Layout,
  page: string,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  const secs = await batch(
    L.sections.map((s) => ({
      name: "create_section",
      input: {
        pageId: page,
        name: s.name,
        color: (s.style?.color ?? "gray").replace("light ", ""),
        x: s.rect.x,
        y: s.rect.y,
        width: s.rect.w,
        height: s.rect.h,
        clientId: `layout.bus.sec.${s.id}`,
      },
    })),
  )
  for (const [i, r] of secs.entries())
    ids.set(L.sections[i].id, idOf(r, "create_section"))
  const cards = L.nodes.filter((n) => n.obstacle)
  const made = await batch(
    cards.map((n) => {
      const sec =
        n.section ? L.sections.find((s) => s.id === n.section) : undefined
      const pos =
        sec ?
          {
            sectionId: ids.get(sec.id),
            x: n.rect.x - sec.rect.x,
            y: n.rect.y - sec.rect.y,
          }
        : { x: n.rect.x, y: n.rect.y }
      return {
        name: "create_shape",
        input: {
          pageId: page,
          text: n.text ?? "",
          shape: n.style?.shape ?? "ROUNDED_RECTANGLE",
          color: n.style?.color ?? "light gray",
          fontFamily: "simple",
          fontSize: n.style?.fontSize ?? 16,
          width: n.rect.w,
          height: n.rect.h,
          ...pos,
          clientId: `layout.bus.card.${n.id}`,
        },
      }
    }),
  )
  for (const [i, r] of made.entries())
    ids.set(cards[i].id, idOf(r, "create_shape"))
  return ids
}

export async function build(
  L: Layout,
  pageId?: string,
  tag = `${L.name}.${Date.now().toString(36)}`,
) {
  truncatedBefore = 0
  gate(L)
  const page =
    pageId
    ?? idOf(
      await tool("create_page", {
        name: OUR_PAGE,
        switchTo: false,
        clientId: "layout.page",
      }),
      "create_page",
    )
  await checkOurPage(page)
  await clearEdges(page)
  const ids = await drawCards(L, page)
  const edges = await drawEdges(L, { page, ids, tag })
  return finish(page, edges.length)
}

export async function overlay(
  L: Layout,
  target: { pageId: string; tree: BoardTree },
  tag = "map",
) {
  const { pageId, tree } = target
  gate(L)
  // hide the existing connectors among our cards (guarded by their revs)
  const cardIds = new Set(L.nodes.map((n) => n.id))
  const hide = tree.edges.filter(
    (e) =>
      e.from !== undefined
      && e.to !== undefined
      && cardIds.has(e.from)
      && cardIds.has(e.to),
  )
  await batch(
    hide.map((e) => ({
      name: "update_node",
      input: {
        pageId,
        id: e.id,
        visible: false,
        expect: { pageId, revs: { [e.id]: e.rev } },
      },
    })),
  )
  const ids = new Map(L.nodes.map((n) => [n.id, n.id]))
  const made = await drawEdges(L, { page: pageId, ids, tag })
  console.log(
    JSON.stringify({
      hidden: hide.map((e) => e.id),
      group: made.at(-1),
    }),
  )
  return finish(pageId, made.length)
}

async function finish(page: string, n: number) {
  const review = record(
    await tool("review_layout", { pageId: page }),
    "review_layout",
  )
  const png = record(
    await tool("export_png", {
      pageId: page,
      rect: { x: -120, y: -120, width: 8160, height: 5440 },
      maxDimension: 4096,
    }),
    "export_png",
  )
  const first: unknown = Array.isArray(png.images) ? png.images[0] : undefined
  const out = {
    page,
    made: n,
    pillsGrown: truncatedBefore,
    review: review.counts,
    png: isRecord(first) ? first.path : undefined,
  }
  console.log(JSON.stringify(out, null, 1))
  return out
}
