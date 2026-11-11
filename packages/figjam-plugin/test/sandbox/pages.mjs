// Stub checks for per-call page targeting (0.8.0): pageId/pageName acts on a
// page without switching the user's view; interleaved targeted calls each land
// on their own page.
import fs from "node:fs"
import vm from "node:vm"
import assert from "node:assert"
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version
const src = fs.readFileSync(process.argv[2], "utf8")
const posted = []
const byId = {}
let seq = 100
function pd() { const d = {}; return { getPluginData: k => d[k] || "", setPluginData: (k, v) => { d[k] = v } } }
function walk(nodes, pred, out) { for (const n of nodes) { if (pred(n)) out.push(n); if (n.children) walk(n.children, pred, out) } return out }
function container(o) {
  o.findAll = pred => walk(o.children, pred || (() => true), [])
  o.findAllWithCriteria = c => walk(o.children, n => (!c.types || c.types.indexOf(n.type) >= 0) && (!c.pluginData || true), [])
  o.appendChild = n => { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); o.children.push(n); n.parent = o }
}
const delay = ms => new Promise(r => setTimeout(r, ms))
function page(id, name) {
  const p = Object.assign({ id, type: "PAGE", name, children: [], selection: [], on() {}, off() {}, loadAsync: async () => { await delay(5) } }, pd())
  container(p); byId[id] = p; return p
}
const pA = page("0:1", "A"), pB = page("0:2", "B"), pC = page("0:3", "C")
const root = Object.assign({ name: "Untitled", children: [pA, pB, pC] }, pd())
for (const p of root.children) p.parent = root
function newNode(type) {
  const n = Object.assign({ id: "9:" + (seq++), type, name: type, x: 0, y: 0, width: 200, height: 120, visible: true, locked: false, fills: [], strokes: [], rotation: 0, opacity: 1,
    text: { characters: "", fontName: { family: "Inter", style: "Medium" }, fontSize: 16, getRangeAllFontNames: () => [{ family: "Inter", style: "Medium" }] },
    resize(w, h) { this.width = w; this.height = h } }, pd())
  Object.defineProperty(n, "absoluteBoundingBox", { get() { return { x: n.x, y: n.y, width: n.width, height: n.height } } })
  Object.defineProperty(n, "absoluteTransform", { get() { return [[1, 0, n.x], [0, 1, n.y]] } })
  byId[n.id] = n
  figma.currentPage.appendChild(n) // like Figma: createX() lands on the current page
  return n
}
const figma = {
  mixed: Symbol("mixed"), root, currentPage: pA, fileKey: "FK1",
  clientStorage: { getAsync: async () => undefined, setAsync: async () => {} },
  listAvailableFontsAsync: async () => [{ fontName: { family: "Inter", style: "Medium" } }],
  loadFontAsync: async () => { await delay(3) },
  createShapeWithText: () => newNode("SHAPE_WITH_TEXT"),
  createSticky: () => newNode("STICKY"),
  showUI() {}, on() {}, notify() {}, commitUndo() {}, viewport: { center: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 1, height: 1 }, zoom: 1 },
  ui: { postMessage: m => posted.push(m), resize() {}, reposition() {} },
  getNodeByIdAsync: async id => byId[id] || null, setCurrentPageAsync: async p => { figma.currentPage = p },
}
const ctx = vm.createContext({ figma, __html__: "<html></html>", console, setTimeout, clearTimeout, Promise, Date, Math, JSON })
vm.runInContext(src, ctx)
let cid = 0
async function call(name, input, actor) {
  const id = "c" + (cid++)
  await figma.ui.onmessage({ type: "tool", id, name, input, actor })
  return posted.find(m => m.type === "tool-result" && m.id === id)
}
;(async () => {
  assert.equal(ctx.PLUGIN_VERSION, PACKAGE_VERSION)
  // schema: central pageId/pageName on ordinary tools; own meaning kept on move_to
  const spec = n => ctx.toolSpecs.find(s => s.name === n).input_schema.properties
  assert.match(spec("create_shape").pageId.description, /without switching the user's view/)
  assert.ok(spec("create_shape").pageName)
  assert.match(spec("move_to").pageId.description, /Move to this page/)
  assert.equal(spec("get_selection").pageId, undefined)

  // a raw tool that never appends explicitly (exercises the stray adoption)
  vm.runInContext(`tool("t_raw", "test", { tag: str() }, [], async function (input) {
    var n = figma.createSticky(); n.name = input.tag; n.x = 7; n.y = 9
    await new Promise(function (r) { setTimeout(r, 10) })
    return { id: n.id, page: activePage().id }
  })`, ctx)

  // create_shape with pageId B: node on B, not A; user's page unchanged
  const r1 = await call("create_shape", { text: "hi", pageId: "0:2" }, "agent:one")
  assert.ok(r1.ok, r1.error)
  assert.equal(figma.currentPage, pA)
  assert.equal(pA.children.length, 0)
  assert.equal(pB.children.length, 1)
  assert.equal(byId[r1.result.id].parent, pB)
  assert.equal(r1.target.pageId, "0:2"); assert.equal(r1.target.pageName, "B")
  assert.equal(ctx.TARGET_PAGE, null)

  // pageName works too; expect.pageId means the page acted on
  const r2 = await call("create_shape", { text: "named", pageName: "C", expect: { pageId: "0:3" } })
  assert.ok(r2.ok, r2.error); assert.equal(byId[r2.result.id].parent, pC)
  const bad = await call("create_shape", { text: "x", pageId: "0:2", expect: { pageId: "0:1" } })
  assert.equal(bad.ok, false); assert.equal(bad.code, "precondition_failed")
  const missing = await call("create_shape", { text: "x", pageName: "Nope" })
  assert.equal(missing.ok, false); assert.equal(missing.code, "not_found")
  assert.equal(pA.children.length, 0)

  // interleaved targeted calls (and an untargeted one) each land on their own page
  const before = { B: pB.children.length, C: pC.children.length }
  const [ra, rb, rc, rd] = await Promise.all([
    call("t_raw", { tag: "onB", pageId: "0:2" }),
    call("t_raw", { tag: "onC", pageId: "0:3" }),
    call("t_raw", { tag: "onCurrent" }),
    call("create_shape", { text: "shapeB", pageId: "0:2" }),
  ])
  for (const r of [ra, rb, rc, rd]) assert.ok(r.ok, r.error)
  assert.equal(byId[ra.result.id].parent, pB); assert.equal(ra.result.page, "0:2"); assert.equal(ra.target.pageId, "0:2")
  assert.equal(byId[rb.result.id].parent, pC); assert.equal(rb.result.page, "0:3"); assert.equal(rb.target.pageId, "0:3")
  assert.equal(byId[rc.result.id].parent, pA); assert.equal(rc.result.page, "0:1"); assert.equal(rc.target.pageId, "0:1")
  assert.equal(byId[rd.result.id].parent, pB)
  assert.equal(byId[ra.result.id].x, 7); assert.equal(byId[ra.result.id].y, 9)
  assert.equal(pB.children.length, before.B + 2); assert.equal(pC.children.length, before.C + 1)
  assert.deepEqual(pA.children.map(n => n.name), ["onCurrent"])
  assert.equal(figma.currentPage, pA); assert.equal(ctx.TARGET_PAGE, null)

  // clientId idempotence is per acted-on page
  const k1 = await call("create_shape", { text: "k", pageId: "0:3", clientId: "same" })
  const k2 = await call("create_shape", { text: "k", pageId: "0:3", clientId: "same" })
  assert.ok(k1.ok && k2.ok); assert.equal(k2.result.changed, false); assert.equal(k2.result.id, k1.result.id)
  console.log("all page-targeting checks passed")
})().catch(e => { console.error(e); process.exit(1) })
