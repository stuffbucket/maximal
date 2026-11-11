// Offline SVG preview of a Layout (sections, cards, routes styled per legend).
import { score, type Layout } from "./model.ts"

const FILL: Record<string, string> = {
  "light blue": "#C2E5FF", "light green": "#CDF4D3", "light red": "#FFC7C2", "light orange": "#FFE0C2", "light violet": "#DCCCFF",
  "light teal": "#C6FAF6", "dark gray": "#757575", gray: "#E6E6E6",
}
const SEC: Record<string, string> = { blue: "#EBF6FF", green: "#EBFAEE", red: "#FFEDEB", orange: "#FFF4EB", violet: "#F3EDFF", teal: "#E9FCFB", gray: "#F5F5F5" }
const EDGE: Record<string, string> = {
  dep: 'stroke="#1E1E1E" stroke-width="3"',
  flow: 'stroke="#8C8C8C" stroke-width="3" stroke-dasharray="12 7"',
  verify: 'stroke="#8C8C8C" stroke-width="3" stroke-dasharray="2 7" stroke-linecap="round"',
  loop: 'stroke="#1E1E1E" stroke-width="7"',
  other: 'stroke="#555" stroke-width="2"',
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

export function toSvg(L: Layout): string {
  const all = [...L.sections.map((s) => s.rect), ...L.nodes.map((n) => n.rect)]
  const x0 = Math.min(...all.map((r) => r.x)) - 120, y0 = Math.min(...all.map((r) => r.y)) - 260
  const x1 = Math.max(...all.map((r) => r.x + r.w)) + 120, y1 = Math.max(...all.map((r) => r.y + r.h)) + 120
  const met = score(L)
  const kind = new Map(L.edges.map((e) => [e.id, e.kind]))
  const o: string[] = []
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${x1 - x0} ${y1 - y0}" width="${Math.round((x1 - x0) / 4)}" height="${Math.round((y1 - y0) / 4)}">`)
  o.push(`<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#1E1E1E"/></marker></defs>`)
  o.push(`<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="#fff"/>`)
  o.push(`<text x="${x0 + 60}" y="${y0 + 110}" font-family="Inter,Helvetica" font-size="72" font-weight="700">${esc(L.name)} — through-node ${met.throughNode}, crossings ${met.crossings}, bends ${met.bends}, length ${met.length}, lane overlaps ${met.laneOverlaps}</text>`)
  for (const s of L.sections) {
    const c = String(s.style?.color ?? "gray").replace("light ", "")
    o.push(`<rect x="${s.rect.x}" y="${s.rect.y}" width="${s.rect.w}" height="${s.rect.h}" rx="16" fill="${SEC[c] ?? "#F5F5F5"}" stroke="#BDBDBD" stroke-width="3"/>`)
    o.push(`<text x="${s.rect.x + 40}" y="${s.rect.y + 80}" font-family="Inter,Helvetica" font-size="56" font-weight="600">${esc(s.name)}</text>`)
  }
  for (const n of L.nodes) {
    if (!n.obstacle) continue
    const f = FILL[String(n.style?.color)] ?? String(n.style?.fillHex ?? "#EEE")
    o.push(`<rect x="${n.rect.x}" y="${n.rect.y}" width="${n.rect.w}" height="${n.rect.h}" rx="${n.style?.shape === "HEXAGON" ? 4 : 20}" fill="${f}" stroke="#9E9E9E" stroke-width="2"/>`)
    const t = (n.text ?? "").split("\n")[0]
    o.push(`<text x="${n.rect.x + n.rect.w / 2}" y="${n.rect.y + n.rect.h / 2 + 12}" text-anchor="middle" font-family="Inter,Helvetica" font-size="32" font-weight="600" fill="${n.style?.color === "dark gray" ? "#fff" : "#1E1E1E"}">${esc(t.slice(0, 26))}</text>`)
  }
  const pieces = (L as any).pieces as { pts: [number, number][]; kind: string; arrow: boolean; count: number; role: string }[] | undefined
  for (const pc of pieces ?? []) {
    const d = "M" + pc.pts.map((p) => p.join(",")).join(" L")
    o.push((pc as any).arrowOnly ? `<path d="${d}" fill="none" stroke="transparent" stroke-width="3" marker-end="url(#a)"/>` : `<path d="${d}" fill="none" ${EDGE[pc.kind] ?? EDGE.other} stroke-linejoin="round" ${pc.arrow ? 'marker-end="url(#a)"' : ""}/>`)
    if (pc.role === "trunk" && pc.count > 1 && pc.pts.length > 1) {
      const [a, b] = longest(pc.pts)
      o.push(`<text x="${(a[0] + b[0]) / 2 + 8}" y="${(a[1] + b[1]) / 2 - 8}" font-family="Inter,Helvetica" font-size="28" fill="#555">${pc.count}</text>`)
    }
  }
  for (const r of L.routes) {
    if (pieces && !r.native) continue
    const d = "M" + r.pts.map((p) => p.join(",")).join(" L")
    o.push(`<path d="${d}" fill="none" ${EDGE[kind.get(r.edge) ?? "other"] ?? EDGE.other} stroke-linejoin="round" marker-end="url(#a)" opacity="${r.native ? 0.9 : 1}"/>`)
  }
  for (const d of ((L as any).doors ?? []) as { pt: [number, number] }[]) o.push(`<circle cx="${d.pt[0]}" cy="${d.pt[1]}" r="10" fill="#F24822"/>`)
  for (const p of ((L as any).swapPts ?? []) as [number, number][]) o.push(`<circle cx="${p[0]}" cy="${p[1]}" r="22" fill="none" stroke="#E000E0" stroke-width="6"/>`)
  for (const t of ((L as any).tags ?? []) as { rect: { x: number; y: number; w: number; h: number }; text: string }[]) {
    o.push(`<rect x="${t.rect.x}" y="${t.rect.y}" width="${t.rect.w}" height="${t.rect.h}" rx="14" fill="#fff" stroke="#7B61FF" stroke-width="2"/>`)
    o.push(`<text x="${t.rect.x + 12}" y="${t.rect.y + 19}" font-family="Inter,Helvetica" font-size="13" fill="#4B3BBF">${esc(t.text)}</text>`)
  }
  for (const l of L.labels ?? []) {
    o.push(`<rect x="${l.rect.x}" y="${l.rect.y}" width="${l.rect.w}" height="${l.rect.h}" rx="12" fill="#fff" stroke="#ccc"/>`)
    o.push(`<text x="${l.rect.x + l.rect.w / 2}" y="${l.rect.y + 17}" text-anchor="middle" font-family="Inter,Helvetica" font-size="13" fill="#555">${esc(l.text)}</text>`)
  }
  o.push("</svg>")
  return o.join("\n")
}

function longest(p: [number, number][]): [[number, number], [number, number]] {
  let best: [[number, number], [number, number]] = [p[0], p[1]]
  let bl = -1
  for (let i = 0; i + 1 < p.length; i++) {
    const l = Math.abs(p[i + 1][0] - p[i][0]) + Math.abs(p[i + 1][1] - p[i][1])
    if (l > bl) { bl = l; best = [p[i], p[i + 1]] }
  }
  return best
}
