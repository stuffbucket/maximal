// Build a planned Layout on the board.
//   build(L, pageId?)       recreate sections + cards on "Map — layout experiment" (a page we own), then edges.
//                           Re-runs reuse the same sections/cards (stable clientIds) and replace the edges.
//   overlay(L, pageId, tree) put the planned edges over an existing map, reversibly: hide the existing
//                           connectors (visible:false, expect.revs) and add new edges in one group
//                           "Routed edges". Revert: delete the group, show the connectors again.
import { tool } from "./client.ts"
import type { Layout, Pt, Route } from "./model.ts"
import { HARD_CHECKS } from "./lanes.ts"

const EDGE_STYLE: Record<string, any> = {
  dep: { color: "black", strokeWeight: 2, endCap: "ARROW_LINES" },
  flow: { color: "gray", strokeWeight: 2, dashPattern: [10, 6], endCap: "ARROW_EQUILATERAL" },
  verify: { color: "gray", strokeWeight: 2, dashPattern: [2, 6], endCap: "CIRCLE_FILLED" },
  loop: { color: "black", strokeWeight: 6, endCap: "TRIANGLE_FILLED" },
  other: { color: "black", strokeWeight: 2, endCap: "ARROW_LINES" },
}

// one arrowhead size everywhere: 14px long, 12px wide, tip exactly on the card border
export const ARROW = { len: 14, half: 6 }
function arrowhead(pts: Pt[]): number[][] {
  const [a, b] = [pts[pts.length - 2], pts[pts.length - 1]]
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len
  const { len: L, half: H } = ARROW
  return [[b[0] - ux * L - uy * H, b[1] - uy * L + ux * H], b, [b[0] - ux * L + uy * H, b[1] - uy * L - ux * H]]
}

// a small filled dot (radius 4 + 6px stroke) whose edge touches the card border
function dot(pts: Pt[]): number[][] {
  const [a, b] = [pts[pts.length - 2], pts[pts.length - 1]]
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len
  const cx = b[0] - ux * 7, cy = b[1] - uy * 7
  return Array.from({ length: 8 }, (_, i) => [cx + 3 * Math.cos((i * Math.PI) / 4), cy + 3 * Math.sin((i * Math.PI) / 4)])
}

async function batch(calls: { name: string; input: any }[], size = 25): Promise<any[]> {
  const out: any[] = []
  for (let i = 0; i < calls.length; i += size) {
    const r = await tool("batch", { calls: calls.slice(i, i + size), stopOnError: true })
    for (const x of r.results) { if (!x.ok) throw new Error(`${x.name}: ${JSON.stringify(x).slice(0, 400)}`); out.push(x.result) }
  }
  return out
}

// Edges: native connectors (planned magnets) + drawn pieces. Returns the ids of everything made.
export let truncatedBefore = 0 // pills whose text came out wider than planned (grown to fit)
async function drawEdges(L: Layout, page: string, ids: Map<string, string>, tag: string): Promise<string[]> {
  const made: string[] = [] // native connectors (they live inside sections, so they can't join the group)
  const loose: string[] = [] // page-level vectors + labels → one group
  const edge = new Map(L.edges.map((e) => [e.id, e]))
  const native = L.routes.filter((r) => r.native)
  const byKind = new Map<string, Route[]>()
  for (const r of native) { const k = edge.get(r.edge)!.kind; byKind.set(k, [...(byKind.get(k) ?? []), r]) }
  for (const [k, rs] of byKind) {
    for (let i = 0; i < rs.length; i += 25) {
      const connections = rs.slice(i, i + 25).map((r) => { const e = edge.get(r.edge)!; return { from: ids.get(e.from) ?? e.from, to: ids.get(e.to) ?? e.to, startMagnet: r.fromMagnet, endMagnet: r.toMagnet, ...(e.label ? { label: e.label } : {}) } })
      const res = await tool("connect", { pageId: page, ...EDGE_STYLE[k], lineType: "ELBOWED", connections, clientId: `layout.${tag}.conn.${k}.${i}` })
      made.push(...(res.created ?? [res]).map((c: any) => c.id))
    }
  }
  // drawn pieces: bundle chains (each drawn once, so dashes stay continuous) and arrowheads
  type Piece = { pts: Pt[]; kind: string; arrow: boolean; arrowOnly?: boolean }
  const pieces = ((L as any).pieces as Piece[] | undefined) ?? L.routes.filter((r) => !r.native).map((r) => ({ pts: r.pts, kind: edge.get(r.edge)!.kind, arrow: true }))
  const strokes: { stroke: any; dash?: number[] }[] = []
  for (const pc of pieces) {
    const st = EDGE_STYLE[pc.kind] ?? EDGE_STYLE.other
    if (!pc.arrowOnly) strokes.push({ stroke: { points: pc.pts, smooth: false, color: st.color, width: st.strokeWeight }, dash: st.dashPattern })
    if (pc.arrow || pc.arrowOnly) {
      if (pc.kind === "verify") strokes.push({ stroke: { points: dot(pc.pts), smooth: true, closed: true, color: st.color, width: 6 } }) // legend: "checks the result" ends in a dot
      else strokes.push({ stroke: { points: arrowhead(pc.pts), smooth: false, color: st.color, width: Math.min(st.strokeWeight, 3) } })
    }
  }
  for (let i = 0; i < strokes.length; i += 40) {
    const chunk = strokes.slice(i, i + 40)
    const res = await tool("draw", { pageId: page, strokes: chunk.map((c) => c.stroke), name: "Routed edge", clientId: `layout.${tag}.route.${i}` })
    const got: string[] = res.ids ?? []
    loose.push(...got)
    const dashed = chunk.flatMap((c, j) => (c.dash && got[j] ? [{ name: "update_node", input: { pageId: page, id: got[j], dashPattern: c.dash } }] : []))
    if (dashed.length) await batch(dashed)
  }
  // labels and name-tag pills: a pill background, then auto-width text on top (auto-width text can't
  // truncate); the pill grows if the text came out wider than planned (counted in `truncated`)
  type Pill = { text: string; rect: { x: number; y: number; w: number; h: number }; kind: "label" | "tag"; link?: string }
  const pills: Pill[] = [
    ...(L.labels ?? []).map((l) => ({ text: l.text, rect: l.rect, kind: "label" as const })),
    ...((((L as any).tags ?? []) as { text: string; rect: any; other: string }[]).map((t) => ({ text: t.text, rect: t.rect, kind: "tag" as const, link: ids.get(t.other) ?? t.other }))),
  ]
  const bgs = await batch(pills.map((p, i) => ({ name: "create_shape", input: { pageId: page, shape: "ROUNDED_RECTANGLE", x: p.rect.x, y: p.rect.y, width: p.rect.w, height: p.rect.h, fill: "#FFFFFF", ...(p.kind === "tag" ? { stroke: "#9747FF", strokeWeight: 1 } : { strokeMode: "none" }), clientId: `layout.${tag}.pillbg.${i}` } })))
  const txts = await batch(pills.map((p, i) => ({ name: "create_text", input: { pageId: page, text: p.text, x: p.rect.x + 12, y: p.rect.y + Math.round((p.rect.h - 20) / 2), textStyle: "caption", color: p.kind === "tag" ? "#5B2BC4" : "#5E5E5E", clientId: `layout.${tag}.pilltext.${i}` } })))
  loose.push(...bgs.map((r) => r.id), ...txts.map((r) => r.id))
  const grow: { name: string; input: any }[] = []
  txts.forEach((t, i) => { const w = Number(t.width ?? 0); if (w + 24 > pills[i].rect.w) { truncatedBefore++; grow.push({ name: "update_node", input: { pageId: page, id: bgs[i].id, width: Math.ceil(w + 24) } }) } })
  if (grow.length) await batch(grow)
  const links = pills.flatMap((p, i) => (p.link ? [{ name: "set_link", input: { pageId: page, id: txts[i].id, nodeId: p.link } }] : []))
  if (links.length) await batch(links)
  if (loose.length) {
    // group takes ≤ 200 ids: group in parts, then group the parts
    let parts = loose.slice()
    while (parts.length > 200) {
      const next: string[] = []
      for (let i = 0; i < parts.length; i += 200) next.push((await tool("group", { pageId: page, ids: parts.slice(i, i + 200), name: "Routed edges (part)" })).id)
      parts = next
    }
    const g = await tool("group", { pageId: page, ids: parts, name: "Routed edges" })
    loose.push(g.id)
  }
  return [...made, ...loose]
}

export function gate(L: Layout) {
  const bad = HARD_CHECKS.filter((k) => (L.checks?.[k] ?? 0) > 0)
  if (bad.length && !process.env.LAYOUT_FORCE) throw new Error(`self-checks failed: ${bad.map((k) => `${k}=${L.checks![k]}`).join(", ")}`)
}

export async function build(L: Layout, pageId?: string, tag = `${L.name}.${Date.now().toString(36)}`) {
  gate(L)
  const page = pageId ?? (await tool("create_page", { name: "Map — layout experiment", switchTo: false, clientId: "layout.page" })).id
  const pages = await tool("list_pages", {})
  const pg = (Array.isArray(pages) ? pages : pages.pages ?? []).find((p: any) => p.id === page)
  if (!pg || pg.name !== "Map — layout experiment") throw new Error(`refusing to build on ${page} (${pg?.name}): not our experiment page`)
  // clear edges from earlier runs on our own page
  for (const types of [["GROUP"], ["CONNECTOR", "VECTOR", "TEXT"]]) {
    const old = await tool("find_nodes", { pageId: page, types, limit: 500 })
    const oldIds = (old.nodes ?? []).filter((n: any) => types[0] !== "GROUP" || /^Routed edges/.test(n.name)).filter((n: any) => !n.groupId).map((n: any) => n.id)
    if (oldIds.length) await tool("delete_nodes", { pageId: page, ids: oldIds, confirm: true })
  }
  const ids = new Map<string, string>()
  const secs = await batch(L.sections.map((s) => ({ name: "create_section", input: { pageId: page, name: s.name, color: String(s.style?.color ?? "gray").replace("light ", ""), x: s.rect.x, y: s.rect.y, width: s.rect.w, height: s.rect.h, clientId: `layout.bus.sec.${s.id}` } })))
  secs.forEach((r, i) => ids.set(L.sections[i].id, r.id))
  const cards = L.nodes.filter((n) => n.obstacle)
  const made = await batch(cards.map((n) => {
    const sec = n.section ? L.sections.find((s) => s.id === n.section) : undefined
    const pos = sec ? { sectionId: ids.get(sec.id), x: n.rect.x - sec.rect.x, y: n.rect.y - sec.rect.y } : { x: n.rect.x, y: n.rect.y }
    return { name: "create_shape", input: { pageId: page, text: n.text ?? "", shape: n.style?.shape ?? "ROUNDED_RECTANGLE", color: n.style?.color ?? "light gray", fontFamily: "simple", fontSize: n.style?.fontSize ?? 16, width: n.rect.w, height: n.rect.h, ...pos, clientId: `layout.bus.card.${n.id}` } }
  }))
  made.forEach((r, i) => ids.set(cards[i].id, r.id))
  const edges = await drawEdges(L, page, ids, tag)
  return finish(page, edges.length)
}

export async function overlay(L: Layout, pageId: string, tree: any, tag = "map") {
  gate(L)
  // hide the existing connectors among our cards (guarded by their revs)
  const cardIds = new Set(L.nodes.map((n) => n.id))
  const hide = (tree.edges ?? []).filter((e: any) => cardIds.has(e.from) && cardIds.has(e.to))
  await batch(hide.map((e: any) => ({ name: "update_node", input: { pageId, id: e.id, visible: false, expect: { pageId, revs: { [e.id]: e.rev } } } })))
  const ids = new Map(L.nodes.map((n) => [n.id, n.id]))
  const made = await drawEdges(L, pageId, ids, tag)
  console.log(JSON.stringify({ hidden: hide.map((e: any) => e.id), group: made[made.length - 1] }))
  return finish(pageId, made.length)
}

async function finish(page: string, n: number) {
  const review = await tool("review_layout", { pageId: page })
  const png = await tool("export_png", { pageId: page, rect: { x: -120, y: -120, width: 8160, height: 5440 }, maxDimension: 4096 })
  const out = { page, made: n, pillsGrown: truncatedBefore, review: review.counts, png: png.images?.[0]?.path }
  console.log(JSON.stringify(out, null, 1))
  return out
}
