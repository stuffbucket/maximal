// Meaning-preserving placement: classify card groups as ORDERED (locked) or UNORDERED (may be
// permuted), with evidence, and search permutations of unordered rows that reduce crossings.
// Nothing here moves anything on the board: it returns suggestions.
import { sectionOf } from "./engine.ts"
import { center, type Edge, type Layout, type Node } from "./model.ts"

export type Group = { section: string; kind: "ORDERED" | "UNORDERED" | "UNSURE"; what: string; cards: string[]; evidence: string[] }
export type Move = { card: string; title: string; from: [number, number]; to: [number, number] }

const title = (n: Node) => (n.text ?? n.id).split("\n")[0]
const overlaps = (a: Node, b: Node) => a.rect.x < b.rect.x + b.rect.w && b.rect.x < a.rect.x + a.rect.w && a.rect.y < b.rect.y + b.rect.h && b.rect.y < a.rect.y + a.rect.h

export function classify(L: Layout): Group[] {
  const groups: Group[] = []
  const m = new Map(L.nodes.map((n) => [n.id, n]))
  for (const s of L.sections) {
    const cards = L.nodes.filter((n) => n.section === s.id && n.obstacle && n.style?.shape !== "ELLIPSE")
    const markers = L.nodes.filter((n) => n.section === s.id && n.style?.shape === "ELLIPSE" && /^\d+$/.test((n.text ?? "").trim()))
    const intra = L.edges.filter((e) => { const [a, b] = sectionOf(L, e); return a === s.id && b === s.id })
    const locked = new Set<string>()
    // 1. numbered markers pinned to cards
    if (markers.length >= 2) {
      const hosts = markers.map((mk) => ({ n: Number(mk.text), host: cards.find((c) => overlaps(c, mk)) })).filter((x) => x.host).sort((a, b) => a.n - b.n)
      if (hosts.length >= 2) {
        groups.push({ section: s.name, kind: "ORDERED", what: "numbered sequence", cards: hosts.map((h) => h.host!.id), evidence: [`numbered markers ${hosts.map((h) => h.n).join(", ")} sit on ${hosts.map((h) => title(h.host!)).join(" → ")}`] })
        hosts.forEach((h) => locked.add(h.host!.id))
      }
    }
    // 2. chevron (step) shapes
    const chevrons = cards.filter((c) => c.style?.shape === "CHEVRON")
    if (chevrons.length >= 2 && !chevrons.every((c) => locked.has(c.id))) {
      groups.push({ section: s.name, kind: "ORDERED", what: "chevron steps", cards: chevrons.map((c) => c.id), evidence: [`${chevrons.length} chevron step shapes in a row`] })
      chevrons.forEach((c) => locked.add(c.id))
    } else if (chevrons.length >= 2) groups[groups.length - 1].evidence.push(`the same cards are chevron step shapes`)
    // 3. chains of consecutive arrows (≥ 3 cards, each step one hop)
    const out = new Map<string, Edge[]>()
    for (const e of intra) out.set(e.from, [...(out.get(e.from) ?? []), e])
    const indeg = new Map<string, number>()
    for (const e of intra) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
    for (const c of cards) {
      if ((indeg.get(c.id) ?? 0) === 1 && (out.get(c.id)?.length ?? 0) === 1) continue // middle of a chain
      let cur = c.id
      const chain = [cur]
      const seen = new Set([cur])
      while ((out.get(cur)?.length ?? 0) === 1) { const nx = out.get(cur)![0].to; if (seen.has(nx) || (indeg.get(nx) ?? 0) !== 1) { if (!seen.has(nx)) chain.push(nx); break } chain.push(nx); seen.add(nx); cur = nx }
      if (chain.length >= 3 && !chain.every((id) => locked.has(id))) {
        groups.push({ section: s.name, kind: "ORDERED", what: "arrow chain", cards: chain, evidence: [`consecutive arrows ${chain.map((id) => title(m.get(id)!)).join(" → ")}`] })
        chain.forEach((id) => locked.add(id))
      }
    }
    // 4. flow direction: are rows layers of a top-to-bottom (or left-to-right) flow?
    let down = 0, right = 0, other = 0
    for (const e of intra) { const a = center(m.get(e.from)!.rect), b = center(m.get(e.to)!.rect); if (b[1] - a[1] > 40) down++; else if (b[0] - a[0] > 40 && Math.abs(b[1] - a[1]) <= 40) right++; else other++ }
    const layered = intra.length >= 3 && down / intra.length >= 0.6
    // 5. rows
    const rows = new Map<number, Node[]>()
    for (const c of cards) rows.set(c.rect.y, [...(rows.get(c.rect.y) ?? []), c])
    const ys = [...rows.keys()].sort((a, b) => a - b)
    if (layered) groups.push({ section: s.name, kind: "ORDERED", what: "row order (flow layers)", cards: ys.map((y) => rows.get(y)![0].id), evidence: [`${down} of ${intra.length} arrows inside the family point downward: rows are steps of a top-to-bottom flow, so rows keep their order`] })
    for (const y of ys) {
      const row = rows.get(y)!.filter((c) => !locked.has(c.id)).sort((a, b) => a.rect.x - b.rect.x)
      if (row.length < 2) continue
      const ids = new Set(row.map((c) => c.id))
      const inRow = intra.filter((e) => ids.has(e.from) && ids.has(e.to))
      const shapes = new Set(row.map((c) => c.style?.shape))
      const ev: string[] = [`${row.length} cards side by side: ${row.map(title).join(", ")}`]
      if (inRow.length) ev.push(`${inRow.length} arrow(s) run inside this row (${inRow.map((e) => `${title(m.get(e.from)!)} → ${title(m.get(e.to)!)}`).join("; ")})`)
      if (shapes.size > 1) ev.push(`mixed shapes (${[...shapes].join(", ")}): tools and rules/fields share the row`)
      const unsure = inRow.length > 0 || shapes.size > 1
      if (!unsure) ev.push("no numbering, no arrows between them, same shape: peers")
      groups.push({ section: s.name, kind: unsure ? "UNSURE" : "UNORDERED", what: `row at y=${y}`, cards: row.map((c) => c.id), evidence: ev })
    }
    void right; void other
  }
  return groups
}

// Hill-climb swaps of equal-width cards inside UNORDERED rows, scored by a fast proxy (total
// Manhattan length of affected edges + 400 × straight-line crossings among them).
export function suggestMoves(L: Layout, groups: Group[]): { moves: Move[]; layout: Layout } {
  const T: Layout = JSON.parse(JSON.stringify(L))
  const m = new Map(T.nodes.map((n) => [n.id, n]))
  const cross = (p: [number, number], q: [number, number], r: [number, number], s: [number, number]) => {
    const o = (a: number[], b: number[], c: number[]) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
    return o(p, q, r) * o(p, q, s) < 0 && o(r, s, p) * o(r, s, q) < 0
  }
  const score = () => {
    const segs = T.edges.map((e) => [center(m.get(e.from)!.rect), center(m.get(e.to)!.rect), e] as [[number, number], [number, number], Edge])
    let len = 0, x = 0
    for (const [a, b] of segs) len += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
      const A = segs[i][2], B = segs[j][2]
      if ([A.from, A.to].some((v) => v === B.from || v === B.to)) continue
      if (cross(segs[i][0], segs[i][1], segs[j][0], segs[j][1])) x++
    }
    return len + 400 * x
  }
  const orig = new Map(T.nodes.map((n) => [n.id, { ...n.rect }]))
  let best = score()
  for (let pass = 0; pass < 4; pass++) {
    let improved = false
    for (const g of groups.filter((g) => g.kind === "UNORDERED")) {
      for (let i = 0; i < g.cards.length; i++) for (let j = i + 1; j < g.cards.length; j++) {
        const a = m.get(g.cards[i])!, b = m.get(g.cards[j])!
        if (a.rect.w !== b.rect.w) continue
        const ax = a.rect.x
        a.rect = { ...a.rect, x: b.rect.x }; b.rect = { ...b.rect, x: ax }
        const sc = score()
        if (sc < best - 1) { best = sc; improved = true } else { b.rect = { ...b.rect, x: a.rect.x }; a.rect = { ...a.rect, x: ax } }
      }
    }
    if (!improved) break
  }
  const moves: Move[] = []
  for (const n of T.nodes) { const o = orig.get(n.id)!; if (o.x !== n.rect.x || o.y !== n.rect.y) moves.push({ card: n.id, title: title(n), from: [o.x, o.y], to: [n.rect.x, n.rect.y] }) }
  return { moves, layout: T }
}
