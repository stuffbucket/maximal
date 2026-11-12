// Stub checks for toolbar/context-menu parity (0.7.0): size presets, font
// family presets, palette swatch names, paint modes, mind map layout (no
// overlaps), edit_table structure ops, move_to across pages, unlock_all.
import fs from "node:fs"
import vm from "node:vm"
import assert from "node:assert"
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version
const src = fs.readFileSync(process.argv[2], "utf8")
const posted = []
const byId = {}
function pd() { const d = {}; return { getPluginData: k => d[k] || "", setPluginData: (k, v) => { d[k] = v } } }
function walk(nodes, pred, out) { for (const n of nodes) { if (pred(n)) out.push(n); if (n.children) walk(n.children, pred, out) } return out }
function container(o) {
  o.findAll = pred => walk(o.children, pred || (() => true), [])
  o.findAllWithCriteria = c => walk(o.children, n => c.types.indexOf(n.type) >= 0, [])
  o.appendChild = n => { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); o.children.push(n); n.parent = o }
}
function mk(o) {
  Object.assign(o, pd()); o.visible = true; o.locked = o.locked || false
  if (o.children) { o.children.forEach(c => { c.parent = o; mk(c) }); container(o) }
  byId[o.id] = o; return o
}
const rgb = (r, g, b) => [{ type: "SOLID", visible: true, color: { r: r / 255, g: g / 255, b: b / 255 } }]
function node(id, type, x, y, extra) {
  return Object.assign({ id, type, name: type, x, y, width: 240, height: 240, fills: [], absoluteBoundingBox: { x, y, width: 240, height: 240 }, absoluteTransform: [[1, 0, x], [0, 1, y]] }, extra)
}
const a = node("1:1", "STICKY", 0, 0, { fills: rgb(0xff, 0xe2, 0x99), text: { characters: "a" } })
const b = node("1:2", "STICKY", 300, 0, { fills: rgb(0xff, 0xe2, 0x99), text: { characters: "b" }, locked: true })
const conn = node("1:3", "CONNECTOR", 0, 0, { connectorStart: { endpointNodeId: "1:1" }, connectorEnd: { endpointNodeId: "1:2" }, text: { characters: "" } })
const sec = node("2:1", "SECTION", 1000, 0, { locked: true, children: [node("2:2", "STICKY", 1100, 100, { locked: true, fills: rgb(0xb3, 0xef, 0xbd), text: { characters: "in" } })] })
const p1 = mk({ id: "0:1", type: "PAGE", name: "Page 1", children: [a, b, conn, sec], selection: [], on() {}, off() {}, loadAsync: async () => {} })
const p2 = mk({ id: "0:2", type: "PAGE", name: "Archive", children: [], selection: [], on() {}, off() {}, loadAsync: async () => {} })
const root = Object.assign({ name: "Untitled", children: [p1, p2] }, pd())
p1.parent = root; p2.parent = root
const fonts = [["Inter", "Regular"], ["Inter", "Medium"], ["Inter", "Bold"], ["Roboto Mono", "Regular"], ["Caveat", "Regular"]].map(([family, style]) => ({ fontName: { family, style } }))
const figma = {
  mixed: Symbol("mixed"), root, currentPage: p1, fileKey: "FK1",
  clientStorage: { getAsync: async () => undefined, setAsync: async () => {} },
  listAvailableFontsAsync: async () => fonts,
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
const hexOf = c => ctx.hex(c)
;(async () => {
  assert.equal(ctx.PLUGIN_VERSION, PACKAGE_VERSION)
  // size presets
  assert.equal(ctx.sizeValue("small", "STICKY"), 16)
  assert.equal(ctx.sizeValue("Extra Large", "STICKY"), 64)
  assert.equal(ctx.sizeValue("extra-large", "TEXT"), 64)
  assert.equal(ctx.sizeValue("xl", "TEXT"), 64)
  assert.equal(ctx.sizeValue("huge", "SHAPE_WITH_TEXT"), 64)
  assert.equal(ctx.sizeValue("medium", "WHATEVER"), 24)
  assert.equal(ctx.sizeValue(20, "STICKY"), 20)
  assert.equal(ctx.sizeValue("18px", "STICKY"), 18)
  assert.equal(ctx.sizeValue(undefined, "STICKY"), undefined)
  assert.equal(ctx.sizeValue("small", "STICKY", { STICKY: { small: 14 } }), 14)
  assert.throws(() => ctx.sizeValue("gigantic", "STICKY"))
  // font presets
  const avail = fonts.map(f => f.fontName)
  assert.equal(ctx.pickFamily("Simple", avail).family, "Inter")
  assert.equal(ctx.pickFamily("technical", avail).family, "Roboto Mono")
  assert.equal(ctx.pickFamily("technical", avail).style, "Medium")
  assert.equal(ctx.pickFamily("Scribbled", avail).family, "Caveat")
  assert.equal(ctx.pickFamily("Scribbled", avail).source, "substitute")
  assert.equal(ctx.pickFamily("Scribbled", []).family, "Figma Hand")
  assert.equal(ctx.pickFamily("bookish", []).family, "Merriweather")
  assert.equal(ctx.pickFamily("bookish", avail.concat([{ family: "Merriweather", style: "Regular" }])).source, "figjam")
  const bk = ctx.pickFamily("bookish", avail)
  assert.equal(bk.family, "Inter"); assert.equal(bk.source, "fallback")
  const bold = await ctx.resolveTextOptions({ fontFamily: "technical", bold: true }, "TEXT")
  assert.equal(bold.fontStyle, undefined); assert.equal(ctx.resolveFont(undefined, bold).style, "Bold")
  assert.equal(ctx.pickFamily("bookish", avail, { bookish: { family: "Roboto Serif", style: "Regular" } }).family, "Roboto Serif")
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.pickFamily("Georgia", avail))), { family: "Georgia", source: "raw" })
  const ro = await ctx.resolveTextOptions({ fontFamily: "technical", fontSize: "large" }, "STICKY")
  assert.equal(ro.fontFamily, "Roboto Mono"); assert.equal(ro.fontSize, 40)
  assert.equal(ctx.closestStyle(avail.filter(f => f.family === "Inter"), "Bold Italic").style, "Bold")
  // palette names
  assert.equal(hexOf(ctx.solid("light blue", ctx.STICKY).color), "#C2E5FF")
  assert.equal(hexOf(ctx.solid("Dark Gray").color), "#757575")
  assert.equal(hexOf(ctx.solid("lighter-gray", ctx.SHAPE, "fill").color), "#F5F5F5")
  assert.equal(hexOf(ctx.pick(ctx.SHAPE, "Light Violet").fill), "#DCCCFF")
  assert.equal(hexOf(ctx.pick(ctx.SHAPE, "light violet").text), "#1E1E1E")
  assert.equal(hexOf(ctx.solid("light_yellow", ctx.TABLE, "fill").color), "#FFECBD")
  assert.equal(hexOf(ctx.solid("pink", ctx.CONNECTOR).color), "#F849C1")
  assert.equal(hexOf(ctx.solid("Light Grey", ctx.SECTION).color), "#D9D9D9")
  assert.throws(() => ctx.solid("mauve", ctx.STICKY), /toolbar swatches/)
  const names = ["black", "dark gray", "red", "orange", "yellow", "green", "teal", "blue", "violet", "pink", "white",
    "light gray", "lighter gray", "light red", "light orange", "light yellow", "light green", "light teal", "light blue", "light violet", "light pink"]
  for (const n of names) for (const pal of [ctx.STICKY, ctx.SHAPE, ctx.SECTION, ctx.CONNECTOR, ctx.TABLE, ctx.LABEL]) assert.ok(ctx.solid(n, pal, "fill").color, n)
  // paint modes
  const shp = { type: "SHAPE_WITH_TEXT", fills: rgb(0x3d, 0xad, 0xff), strokes: [], dashPattern: [] }
  ctx.applyPaintModes(shp, { fillMode: "transparent", strokeMode: "dashed" })
  assert.equal(shp.fills[0].opacity, ctx.TRANSPARENT_OPACITY); assert.equal(hexOf(shp.fills[0].color), "#3DADFF")
  assert.deepEqual(Array.from(shp.dashPattern), [10, 6]); assert.equal(shp.strokes.length, 1)
  ctx.applyPaintModes(shp, { fillMode: "none", strokeMode: "none" })
  assert.equal(shp.fills.length, 0); assert.equal(shp.strokes.length, 0)
  assert.throws(() => ctx.applyPaintModes(shp, { fillMode: "glass" }))
  // mind map layout: no overlaps, root first, parents valid
  const tree = { text: "Product launch plan", children: [
    { text: "Marketing", children: [{ text: "Blog post" }, { text: "Social campaign across three channels" }, { text: "Press" }] },
    { text: "Engineering", children: [{ text: "API", children: [{ text: "Rate limits" }, { text: "Docs" }] }, { text: "UI" }] },
    { text: "Sales", children: ["Pricing page", "Enablement deck"] },
    { text: "Support" }, { text: "Legal review", children: [{ text: "Terms" }] },
  ] }
  function overlaps(items) {
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const p = items[i], q = items[j]
      if (p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h) return [p.text, q.text]
    }
    return null
  }
  for (const layout of ["right", "both", "radial"]) {
    const items = ctx.mindMapLayout(tree, layout)
    assert.equal(items.length, 16, layout)
    assert.equal(items[0].text, "Product launch plan"); assert.equal(items[0].parent, -1)
    assert.equal(overlaps(items), null, layout + " overlap " + overlaps(items))
    items.slice(1).forEach(it => { assert.ok(it.parent >= 0 && it.parent < items.length); assert.ok(it.branch >= 0 && it.branch < 5) })
    if (layout === "right") items.slice(1).forEach(it => assert.ok(it.x > items[0].x + items[0].w, it.text))
    if (layout === "both") {
      const sides = new Set(items.slice(1).map(it => it.side))
      assert.ok(sides.has(1) && sides.has(-1))
      items.slice(1).forEach(it => assert.ok(it.side > 0 ? it.x >= items[0].w : it.x + it.w <= 0, it.text))
    }
  }
  // wide fan-out radial (many siblings) still has no overlaps
  const fan = { text: "Root", children: Array.from({ length: 24 }, (_, i) => ({ text: "Idea number " + i, children: [{ text: "detail " + i }] })) }
  assert.equal(overlaps(ctx.mindMapLayout(fan, "radial")), null)
  assert.equal(overlaps(ctx.mindMapLayout(fan, "both")), null)
  assert.throws(() => ctx.mindMapLayout(tree, "spiral"))
  // table structure ops
  const log = []
  const t = { numRows: 4, numColumns: 3,
    insertRow(i) { log.push(["insertRow", i]); this.numRows++ }, insertColumn(i) { log.push(["insertColumn", i]); this.numColumns++ },
    removeRow(i) { log.push(["removeRow", i]); this.numRows-- }, removeColumn(i) { log.push(["removeColumn", i]); this.numColumns-- },
    moveRow(f, to) { log.push(["moveRow", f, to]) }, moveColumn(f, to) { log.push(["moveColumn", f, to]) },
    resizeRow(i, hh) { log.push(["resizeRow", i, hh]) }, resizeColumn(i, w) { log.push(["resizeColumn", i, w]) } }
  const run = input => { log.length = 0; ctx.tableStructure(t, input); return log.map(x => x.join(":")) }
  assert.deepEqual(run({ addRow: { at: 1, where: "above" } }), ["insertRow:1"])
  assert.deepEqual(run({ addRow: { at: 1 } }), ["insertRow:2"])
  assert.deepEqual(run({ addColumn: { at: 0, where: "right", count: 2 } }), ["insertColumn:1", "insertColumn:1"])
  assert.deepEqual(run({ addColumn: { at: 2, where: "left" } }), ["insertColumn:2"])
  assert.deepEqual(run({ moveRow: { from: 2, direction: "up" } }), ["moveRow:2:1"])
  assert.deepEqual(run({ moveRow: { from: 1, direction: "down", by: 2 } }), ["moveRow:1:3"])
  assert.deepEqual(run({ moveColumn: { from: 0, direction: "right" } }), ["moveColumn:0:1"])
  assert.deepEqual(run({ moveRow: { from: 1, to: 1 } }), [])
  assert.throws(() => run({ moveRow: { from: 0, direction: "up" } }), /already at the top/)
  assert.throws(() => run({ moveColumn: { from: 0, direction: "up" } }), /left or right/)
  assert.throws(() => run({ addRow: { at: 1, where: "left" } }), /above or below/)
  assert.throws(() => run({ addRow: { at: 99 } }), /outside the table/)
  const nr = t.numRows
  assert.deepEqual(run({ deleteRow: [0, 2, 2] }), ["removeRow:2", "removeRow:0"]); assert.equal(t.numRows, nr - 2)
  assert.deepEqual(run({ removeColumn: 1, deleteColumn: [0] }), ["removeColumn:1", "removeColumn:0"])
  assert.throws(() => run({ deleteRow: Array.from({ length: t.numRows }, (_, i) => i) }), /every row/)
  assert.deepEqual(run({ insertRow: t.numRows }), ["insertRow:" + (t.numRows - 1)])
  assert.ok(ctx.isDestructive("edit_table", { deleteRow: 1 }) && ctx.isDestructive("edit_table", { deleteColumn: [0] }))
  assert.ok(!ctx.isDestructive("edit_table", { addRow: { at: 0 } }))
  assert.ok(/Merge cells is NOT possible/.test(ctx.toolSpecs.find(s => s.name === "edit_table").description))
  // move_to another page: guarded, then moves and reports the connector left behind
  let out = await call("move_to", { ids: ["1:1"], pageName: "Archive" }, "agent:a")
  assert.equal(out.code, "confirm_required")
  out = await call("move_to", { ids: ["1:1"], pageName: "Archive", confirm: true }, "agent:a")
  assert.equal(out.ok, true, out.error)
  assert.equal(a.parent, p2); assert.equal(a.x, 0)
  assert.deepEqual(out.result.connectorsLeft, ["1:3"]); assert.equal(out.result.page.id, "0:2")
  out = await call("move_to", { ids: ["1:1"], pageId: "0:2", confirm: true }, "agent:a")
  assert.equal(out.result.changed, false); assert.deepEqual(out.result.alreadyThere, ["1:1"])
  out = await call("move_to", { ids: ["1:2"] }, "agent:a")
  assert.equal(out.ok, false)
  // unlock_all
  out = await call("unlock_all", {}, "agent:a")
  assert.equal(out.code, "confirm_required")
  out = await call("unlock_all", { confirm: true }, "agent:a")
  assert.equal(out.ok, true, out.error)
  assert.deepEqual(out.result.ids.slice().sort(), ["1:2", "2:1", "2:2"])
  assert.ok(!b.locked && !sec.locked && !sec.children[0].locked)
  out = await call("unlock_all", { confirm: true }, "agent:a")
  assert.equal(out.result.changed, false)
  // schemas
  const spec = n => ctx.toolSpecs.find(s => s.name === n).input_schema.properties
  for (const n of ["create_text", "create_shape", "update_node", "style_text"]) assert.ok(spec(n).fontFamily && spec(n).fontSize, n)
  assert.ok(spec("create_stickies").fontFamily && spec("create_stickies").items.items.properties.authorVisible)
  assert.ok(spec("update_node").authorVisible && spec("update_node").fillMode && spec("create_shape").strokeMode)
  assert.ok(spec("create_mind_map").clientId && spec("move_to").confirm && spec("unlock_all").confirm)
  assert.ok(spec("calibrate_fonts") && !spec("calibrate_fonts").expect)
  console.log("all toolbar checks passed")
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
