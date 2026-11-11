// Stub-based checks for the sandbox side (rev, expect, rename_page, read_markup, board_tree).
import fs from "node:fs"
import vm from "node:vm"
import assert from "node:assert"
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version
const src = fs.readFileSync(process.argv[2], "utf8")
const posted = []
const byId = {}
function pd() { const d = {}; return { getPluginData: k => d[k] || "", setPluginData: (k, v) => { d[k] = v } } }
function walk(nodes, pred, out) { for (const n of nodes) { if (pred(n)) out.push(n); if (n.children) walk(n.children, pred, out) } return out }
function mk(o) { Object.assign(o, pd()); o.visible = true; o.locked = false; if (o.children) o.children.forEach(c => { c.parent = o; mk(c) }); byId[o.id] = o; return o }
function page(id, name, children) { const p = mk({ id, type: "PAGE", name, children, selection: [], on() {}, off() {}, loadAsync: async () => {} }); p.findAll = pred => walk(p.children, pred || (() => true), []); return p }
function abs(n) { const b = n.absoluteBoundingBox; n.x = b.x; n.y = b.y; n.width = b.width; n.height = b.height; n.absoluteTransform = [[1, 0, b.x], [0, 1, b.y]]; if (n.children) n.findAll = pred => walk(n.children, pred || (() => true), []); return n }
const yellow = [{ type: "SOLID", visible: true, color: { r: 1, g: 0.85, b: 0.2 } }]
const black = [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 } }]
function cellsTable() {
  return abs({ id: "6:7", type: "TABLE", name: "Table", numRows: 3, numColumns: 3, fills: [], absoluteBoundingBox: { x: 100, y: 100, width: 300, height: 120 },
    cellAt: (r, c) => ({ width: 100, height: 40, fills: [], text: { characters: r === 0 ? "H" + c : "r" + r + "c" + c } }) })
}
function hl(id, r, c) { // highlighter swipe across cell (r, c)
  const x = 100 + c * 100 + 5, y = 100 + r * 40 + 8
  return abs({ id, type: "HIGHLIGHT", name: "Highlight", opacity: 1, strokeWeight: 20, strokes: yellow, fills: [], absoluteBoundingBox: { x, y, width: 90, height: 24 },
    vectorNetwork: { vertices: [{ x: 0, y: 12 }, { x: 45, y: 13 }, { x: 90, y: 12 }] }, vectorPaths: [{ data: "M 0 12 L 90 12" }] })
}
function pen(id, pts) {
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), x = Math.min(...xs), y = Math.min(...ys)
  return abs({ id, type: "VECTOR", name: "Vector", opacity: 1, strokeWeight: 4, strokes: black, fills: [], absoluteBoundingBox: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y },
    vectorNetwork: { vertices: pts.map(p => ({ x: p[0] - x, y: p[1] - y })) }, vectorPaths: [{ data: "M 0 0 L 1 1" }] })
}
const highlights = [[1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2], [0, 1]].map((rc, i) => hl("9:" + i, rc[0], rc[1]))
const sec3 = abs({ id: "6:3", type: "SECTION", name: "Data", fills: [], sectionContentsHidden: false, absoluteBoundingBox: { x: 80, y: 60, width: 360, height: 200 }, children: [cellsTable()] })
const txt = abs({ id: "6:8", type: "TEXT", name: "t", characters: "Remove this idea", fontSize: 16, fills: black, absoluteBoundingBox: { x: 650, y: 230, width: 200, height: 40 } })
const sec6 = abs({ id: "6:6", type: "SECTION", name: "Old idea", fills: [], absoluteBoundingBox: { x: 600, y: 100, width: 300, height: 300 }, children: [txt] })
const strokeA = pen("10:1", [[612, 112], [700, 205], [800, 300], [888, 388]])
const strokeB = pen("10:2", [[886, 114], [790, 210], [700, 300], [614, 386]])
const p1 = page("0:1", "Page 1", [sec3, sec6, strokeA, strokeB].concat(highlights))
const p2 = page("0:2", "Notes", [])
const root = Object.assign({ name: "Untitled", children: [p1, p2] }, pd())
const figma = {
  mixed: Symbol("mixed"), root, currentPage: p1, fileKey: "FK1",
  clientStorage: { getAsync: async () => undefined, setAsync: async () => {} },
  showUI() {}, on() {}, notify() {}, commitUndo() {}, viewport: { center: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 1, height: 1 }, zoom: 1 },
  ui: { postMessage: m => posted.push(m), resize() {}, reposition() {} },
  getNodeByIdAsync: async id => byId[id] || null, setCurrentPageAsync: async p => { figma.currentPage = p },
}
const ctx = vm.createContext({ figma, __html__: "<html></html>", console, setTimeout, clearTimeout, Promise, Date, Math, JSON })
vm.runInContext(src, ctx)
async function call(name, input, actor) {
  posted.length = 0
  await figma.ui.onmessage({ type: "tool", id: "x", name, input, actor })
  return posted.find(m => m.type === "tool-result")
}
;(async () => {
  // rev
  const r1 = ctx.rev(txt); assert.match(r1, /^[0-9a-f]{8}$/); assert.equal(ctx.rev(txt), r1)
  txt.characters = "Remove this idea!"; assert.notEqual(ctx.rev(txt), r1); txt.characters = "Remove this idea"; assert.equal(ctx.rev(txt), r1)
  assert.equal(ctx.rev(p1), ctx.fnv1a("0:1\u0000Page 1"))
  // expect
  let out = await call("rename_page", { pageId: "0:1", name: "X", expect: { revs: { "6:8": "deadbeef" } } }, "agent:a")
  assert.equal(out.code, "precondition_failed"); assert.equal(out.mismatches[0].actual, r1); assert.equal(p1.name, "Page 1"); assert.equal(out.target.pageId, "0:1")
  out = await call("rename_page", { pageId: "0:1", name: "X", expect: { revs: { "99:9": "deadbeef" } } }, "agent:a")
  assert.equal(out.code, "not_found")
  out = await call("rename_page", { pageId: "0:1", name: "X", expect: { pageId: "0:2" } }, "agent:a")
  assert.equal(out.code, "precondition_failed"); assert.equal(out.mismatches[0].field, "pageId")
  // rename_page guard + idempotence
  out = await call("rename_page", { pageId: "0:2", name: "Retro" }, "agent:a")
  assert.equal(out.code, "confirm_required"); assert.equal(p2.name, "Notes")
  out = await call("rename_page", { name: "Retro", confirm: true }, "agent:a")
  assert.equal(out.code, "bad_input")
  out = await call("rename_page", { pageId: "0:2", from: "Wrong", name: "Retro", confirm: true }, "agent:a")
  assert.equal(out.code, "precondition_failed"); assert.equal(p2.name, "Notes")
  out = await call("rename_page", { pageId: "0:2", from: "Notes", name: "Retro", expect: { names: { "0:2": "Notes" } } }, "agent:a")
  assert.equal(out.ok, true); assert.equal(out.result.changed, true); assert.equal(p2.name, "Retro"); assert.equal(out.result.target.fileKey, "FK1"); assert.ok(out.result.revs["0:2"])
  out = await call("rename_page", { pageId: "0:2", from: "Notes", name: "Retro", confirm: true }, "agent:a")
  assert.equal(out.ok, true); assert.equal(out.result.changed, false)
  // read_markup
  out = await call("read_markup", {}, "agent:a")
  assert.equal(out.ok, true, out.error)
  const items = out.result.items
  const cross = items.filter(i => i.gesture === "cross")
  assert.equal(cross.length, 1, JSON.stringify(items.map(i => [i.id, i.gesture]))); assert.deepEqual(cross[0].ids, ["10:1", "10:2"])
  assert.ok(cross[0].covers.some(c => c.id === "6:6"), JSON.stringify(cross[0].covers))
  assert.ok(!cross[0].covers.some(c => c.id === "6:3"))
  const hls = items.filter(i => i.kind === "highlight")
  assert.equal(hls.length, 7)
  for (const h of hls) { const cells = h.covers.filter(c => c.cell); assert.equal(cells.length, 1, JSON.stringify(h.covers)); assert.ok(!h.covers.some(c => c.type === "SECTION")) }
  const h11 = hls.find(h => h.id === "9:1"); assert.deepEqual(h11.covers[0].cell, { row: 1, col: 1, colHeader: "H1", rowHeader: "r1c0" }); assert.equal(h11.textCovered, "r1c1")
  // classifier
  const B = (pts) => { const xs = pts.map(p => p.x), ys = pts.map(p => p.y); return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } }
  const circle = []; for (let a = 0; a <= 360; a += 20) circle.push({ x: 100 + 50 * Math.cos(a * Math.PI / 180), y: 100 + 40 * Math.sin(a * Math.PI / 180) })
  assert.equal(ctx.classifyStroke(circle, B(circle), 1), "circle")
  const check = [{ x: 0, y: 20 }, { x: 10, y: 30 }, { x: 20, y: 40 }, { x: 35, y: 20 }, { x: 50, y: 0 }]
  assert.equal(ctx.classifyStroke(check, B(check), 1), "check")
  const arrow = [{ x: 0, y: 50 }, { x: 100, y: 50 }, { x: 200, y: 50 }, { x: 180, y: 35 }]
  assert.equal(ctx.classifyStroke(arrow, B(arrow), 1), "arrow")
  const line = [{ x: 0, y: 0 }, { x: 100, y: 2 }, { x: 200, y: 1 }]
  assert.equal(ctx.classifyStroke(line, B(line), 1), "line")
  assert.equal(ctx.underlineOrStrike({ x: 650, y: 266, width: 200, height: 4 }, [{ id: "6:8", type: "TEXT" }], [{ id: "6:8", bounds: txt.absoluteBoundingBox }]), "underline")
  assert.equal(ctx.underlineOrStrike({ x: 650, y: 248, width: 200, height: 4 }, [{ id: "6:8", type: "TEXT" }], [{ id: "6:8", bounds: txt.absoluteBoundingBox }]), "strike")
  // board_tree
  out = await call("board_tree", {}, "agent:a")
  assert.equal(out.ok, true, out.error); assert.equal(out.result.root.children[0].id, "6:3"); assert.equal(out.result.root.children[0].children[0].role, "table")
  assert.equal(out.result.markup.length, 8)
  console.log("all sandbox checks passed")
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
