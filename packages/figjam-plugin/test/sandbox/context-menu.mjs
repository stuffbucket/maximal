// Stub checks for the context-menu tools: flip math, table sort order,
// convert color mapping, select match filtering, sort_stickies grouping.
import fs from "node:fs"
import vm from "node:vm"
import assert from "node:assert"
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version
const src = fs.readFileSync(process.argv[2], "utf8")
const posted = []
const byId = {}
function pd() { const d = {}; return { getPluginData: k => d[k] || "", setPluginData: (k, v) => { d[k] = v } } }
function walk(nodes, pred, out) { for (const n of nodes) { if (pred(n)) out.push(n); if (n.children) walk(n.children, pred, out) } return out }
function mk(o) {
  Object.assign(o, pd()); o.visible = true; o.locked = false
  if (o.children) { o.children.forEach(c => { c.parent = o; mk(c) }); o.findAll = pred => walk(o.children, pred || (() => true), []) }
  byId[o.id] = o; return o
}
const rgb = (r, g, b) => [{ type: "SOLID", visible: true, color: { r: r / 255, g: g / 255, b: b / 255 } }]
function node(id, type, x, y, extra) {
  return Object.assign({ id, type, name: type, x, y, width: 240, height: 240, fills: [], absoluteBoundingBox: { x, y, width: 240, height: 240 }, absoluteTransform: [[1, 0, x], [0, 1, y]] }, extra)
}
const sY = node("1:1", "STICKY", 0, 0, { fills: rgb(0xff, 0xe2, 0x99), authorName: "Ann", text: { characters: "beta" } })
const sB = node("1:2", "STICKY", 300, 0, { fills: rgb(0xa8, 0xda, 0xff), authorName: "Bob", text: { characters: "alpha" } })
const sY2 = node("1:3", "STICKY", 600, 0, { fills: rgb(0xff, 0xe2, 0x99), authorName: "Bob", text: { characters: "gamma" } })
const shp = node("1:4", "SHAPE_WITH_TEXT", 0, 400, { shapeType: "DIAMOND", fills: rgb(0x3d, 0xad, 0xff), text: { characters: "d" } })
const sec = node("2:1", "SECTION", 1000, 0, { children: [node("2:2", "STICKY", 1100, 100, { fills: rgb(0xb3, 0xef, 0xbd), authorName: "Ann", text: { characters: "in" } })] })
const p1 = mk({ id: "0:1", type: "PAGE", name: "Page 1", children: [sY, sB, sY2, shp, sec], selection: [], on() {}, off() {}, loadAsync: async () => {} })
const root = Object.assign({ name: "Untitled", children: [p1] }, pd())
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
function apply(t, x, y) { return [t[0][0] * x + t[0][1] * y + t[0][2], t[1][0] * x + t[1][1] * y + t[1][2]] }
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + " != " + b)
;(async () => {
  // flip: center stays put, corners mirror; rotated transforms too; double flip = identity
  const w = 200, h = 100
  for (const deg of [0, 30, 90]) {
    const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r)
    const t = [[c, s, 50], [-s, c, 80]]
    for (const [fh, fv] of [[true, false], [false, true], [true, true]]) {
      const f = ctx.flipTransform(t, w, h, fh, fv)
      const c0 = apply(t, w / 2, h / 2), c1 = apply(f, w / 2, h / 2)
      near(c0[0], c1[0]); near(c0[1], c1[1])
      const p = apply(f, 0, 0), q = apply(t, fh ? w : 0, fv ? h : 0)
      near(p[0], q[0]); near(p[1], q[1])
      const back = ctx.flipTransform(f, w, h, fh, fv)
      for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) near(back[i][j], t[i][j])
    }
  }
  // sort order: numeric-aware, empties last, desc, stable
  const vals = ["10", "9", "", "$1,200", "apple", "Banana", "item10", "item2", "5%"]
  const asc = Array.from(ctx.sortOrder(vals, false)).map(i => vals[i])
  assert.deepEqual(asc, ["5%", "9", "10", "$1,200", "apple", "Banana", "item2", "item10", ""])
  const desc = Array.from(ctx.sortOrder(vals, true)).map(i => vals[i])
  assert.deepEqual(desc, ["item10", "item2", "Banana", "apple", "$1,200", "10", "9", "5%", ""])
  assert.deepEqual(Array.from(ctx.sortOrder(["b", "a", "b"], false)), [1, 0, 2])
  // table sort applies moveRow so rows move whole, header kept
  const rows = [["Name", "N"], ["c", "3"], ["a", "10"], ["b", "2"]]
  const table = { numRows: 4, numColumns: 2, cellAt: (r, c) => ({ text: { characters: rows[r][c] } }), moveRow(f, t) { rows.splice(t, 0, rows.splice(f, 1)[0]) } }
  ctx.sortTableRows(table, { col: 1 })
  assert.deepEqual(rows.map(r => r[0]), ["Name", "b", "c", "a"])
  ctx.sortTableRows(table, { col: 0, desc: true })
  assert.deepEqual(rows.map(r => r[0]), ["Name", "c", "b", "a"])
  // convert color mapping
  assert.equal(ctx.mapColorName(ctx.STICKY, ctx.SHAPE, rgb(0xa8, 0xda, 0xff)), "blue")
  assert.equal(ctx.mapColorName(ctx.SHAPE, ctx.STICKY, rgb(0x87, 0x4f, 0xff)), "violet")
  assert.equal(ctx.mapColorName(ctx.SHAPE, ctx.STICKY, rgb(0x1e, 0x1e, 0x1e)), "gray")
  assert.equal(ctx.mapColorName(ctx.STICKY, ctx.SHAPE, rgb(0xff, 0xe0, 0x9a)), "yellow") // custom near yellow sticky → nearest shape
  assert.equal(ctx.mapColorName(ctx.STICKY, ctx.SHAPE, []), undefined)
  // select match
  let out = await call("select", { match: { type: "sticky" } }, "agent:a")
  assert.equal(out.ok, true, out.error); assert.deepEqual(out.result.selected, ["1:1", "1:2", "1:3", "2:2"])
  out = await call("select", { match: { sameAs: "1:1", by: ["type", "color"] } }, "agent:a")
  assert.deepEqual(out.result.selected, ["1:1", "1:3"])
  out = await call("select", { match: { color: "blue" } }, "agent:a")
  assert.deepEqual(out.result.selected, ["1:2", "1:4"])
  out = await call("select", { match: { sameAs: "1:2", by: ["author"] } }, "agent:a")
  assert.deepEqual(out.result.selected, ["1:2", "1:3"])
  out = await call("select", { match: { shape: "DIAMOND" } }, "agent:a")
  assert.deepEqual(out.result.selected, ["1:4"])
  out = await call("select", { match: { inSectionId: "2:1", all: true } }, "agent:a")
  assert.deepEqual(out.result.selected, ["2:2"])
  out = await call("select", { match: { all: true } }, "agent:a")
  assert.equal(out.result.count, 5); assert.equal(p1.selection.length, 5)
  out = await call("select", { match: {} }, "agent:a")
  assert.equal(out.ok, false)
  // sort_stickies grouping
  const items = [{ id: "a", color: "yellow", author: "Bob", text: "beta" }, { id: "b", color: "blue", author: "", text: "alpha" }, { id: "c", color: "yellow", author: "Ann", text: "Gamma" }, { id: "d", color: "custom", author: "Ann", text: "item10" }, { id: "e", color: "custom", author: "Ann", text: "item2" }]
  const lab = gs => gs.map(g => [g.label, g.ids])
  assert.deepEqual(lab(ctx.groupStickies(items, "color")), [["Blue", ["b"]], ["Yellow", ["a", "c"]], ["Custom", ["d", "e"]]])
  assert.deepEqual(lab(ctx.groupStickies(items, "author")), [["Ann", ["c", "d", "e"]], ["Bob", ["a"]], ["No author", ["b"]]])
  assert.deepEqual(lab(ctx.groupStickies(items, "text")), [[null, ["b", "a", "c", "e", "d"]]])
  assert.deepEqual(lab(ctx.groupStickies(items, "groups", [{ label: "X", ids: ["c", "zz", "a"] }, { label: "Y", ids: ["a"] }])), [["X", ["c", "a"]], ["Other", ["b", "d", "e"]]])
  // destructive registration
  out = await call("convert_node", { ids: ["1:1"], to: "SHAPE" }, "agent:a")
  assert.equal(out.code, "confirm_required")
  const spec = n => ctx.toolSpecs.find(s => s.name === n).input_schema.properties
  assert.ok(spec("convert_node").confirm && spec("convert_node").expect)
  assert.ok(spec("copy_style").expect && spec("sort_stickies").expect)
  out = await call("edit_table", { id: "1:1", clearCell: [{ row: 0, col: 0 }] }, "agent:a")
  assert.equal(out.code, "confirm_required")
  // run_code: the panel's own agent needs no confirm (the "Allow run_code"
  // setting is the consent); remote agents still do.
  out = await call("run_code", { code: "return 1" }, "agent:a")
  assert.equal(out.code, "confirm_required")
  ctx.guardDestructive("run_code", { code: "return 1" }, "panel:test")
  assert.throws(() => ctx.guardDestructive("run_code", { code: "return 1" }, "agent:a"), e => e.code === "confirm_required" || /confirm_required/.test(String(e.message)))
  assert.equal(ctx.PLUGIN_VERSION, PACKAGE_VERSION)
  console.log("all context-menu checks passed")
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
