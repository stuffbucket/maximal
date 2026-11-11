// Stub checks for the type ramp (0.9.0): role resolution, overrides, style
// fallback + sticky clamp, application to a text target, type_ramp, and
// review_layout's off-ramp-text issue.
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
function textNode(id, x, y, chars, size, family, style) {
  return { id, type: "TEXT", name: "t", characters: chars, fontSize: size, fontName: { family, style }, fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 } }],
    x, y, width: 300, height: size * 1.5, absoluteBoundingBox: { x, y, width: 300, height: size * 1.5 }, absoluteTransform: [[1, 0, x], [0, 1, y]] }
}
const onRamp = textNode("1:1", 0, 0, "Checkout flow", 28, "Inter", "Semi Bold")
const offRamp = textNode("1:2", 0, 400, "Some notes", 22, "Inter", "Regular")
const mono = textNode("1:3", 0, 800, "create_text", 15, "Roboto Mono", "Medium")
const p1 = mk({ id: "0:1", type: "PAGE", name: "Page 1", children: [onRamp, offRamp, mono], selection: [], on() {}, off() {}, loadAsync: async () => {} })
p1.findAll = pred => walk(p1.children, pred || (() => true), [])
const root = Object.assign({ name: "Untitled", children: [p1] }, pd())
// Inter has no Semi Bold here (→ Bold); Roboto Mono has no Regular (→ Medium).
const installed = [["Inter", "Regular"], ["Inter", "Medium"], ["Inter", "Bold"], ["Roboto Mono", "Medium"], ["Merriweather", "Regular"], ["Figma Hand", "Regular"]]
const fonts = installed.map(([family, style]) => ({ fontName: { family, style } }))
const figma = {
  mixed: Symbol("mixed"), root, currentPage: p1, fileKey: "FK1",
  clientStorage: { getAsync: async () => undefined, setAsync: async () => {} },
  listAvailableFontsAsync: async () => fonts,
  loadFontAsync: async f => { if (!installed.some(([a, b]) => a === f.family && b === f.style)) throw new Error("missing " + f.family + " " + f.style) },
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
function fakeText(chars) {
  const t = { characters: chars, fontName: { family: "Inter", style: "Medium" }, fontSize: 24, calls: {} }
  t.getRangeAllFontNames = () => [t.fontName]
  t.getStyledTextSegments = () => [{ start: 0, end: t.characters.length, fontName: t.fontName }]
  t.setRangeFontName = (s, e, f) => { t.fontName = f }
  t.setRangeFontSize = (s, e, v) => { t.fontSize = v }
  t.setRangeLineHeight = (s, e, v) => { t.lineHeight = v }
  t.setRangeLetterSpacing = (s, e, v) => { t.letterSpacing = v }
  t.setRangeTextCase = (s, e, v) => { t.textCase = v }
  t.setRangeFills = () => {}
  return t
}
;(async () => {
  assert.equal(ctx.PLUGIN_VERSION, PACKAGE_VERSION)
  // Resolution: full role, with style fallback reported.
  let o = await ctx.resolveTextOptions({ textStyle: "section" }, "TEXT")
  assert.equal(o.fontFamily, "Inter"); assert.equal(o.fontStyle, "Bold"); assert.equal(o.fontSize, 28)
  assert.equal(o.lineHeight, 36); assert.equal(o.letterSpacing, -0.5)
  assert.match(o.__ramp.substitutions.join(" "), /Inter Semi Bold isn't installed; used Bold/)
  o = await ctx.resolveTextOptions({ textStyle: "label" }, "TEXT")
  assert.equal(o.textCase, "UPPER"); assert.equal(o.letterSpacing, 4); assert.equal(o.fontSize, 12)
  o = await ctx.resolveTextOptions({ textStyle: "Code Label" }, "TEXT")
  assert.equal(o.fontFamily, "Roboto Mono"); assert.equal(o.fontStyle, "Medium"); assert.equal(o.__ramp.substitutions, undefined)
  o = await ctx.resolveTextOptions({ textStyle: "code" }, "TEXT")
  assert.equal(o.fontStyle, "Medium"); assert.match(o.__ramp.substitutions[0], /Roboto Mono Regular/)
  o = await ctx.resolveTextOptions({ textStyle: "body" }, "TEXT")
  assert.equal(o.fontStyle, "Regular"); assert.equal(o.lineHeight, 24); assert.equal(o.__ramp.substitutions, undefined)
  // Overrides: explicit fontSize / fontFamily win; line height follows the size on the 4px grid.
  o = await ctx.resolveTextOptions({ textStyle: "body", fontSize: 20, fontFamily: "bookish" }, "TEXT")
  assert.equal(o.fontSize, 20); assert.equal(o.fontFamily, "Merriweather"); assert.equal(o.lineHeight, 32)
  assert.deepEqual(Array.from(o.__ramp.overridden), ["fontFamily", "fontSize"])
  o = await ctx.resolveTextOptions({ textStyle: "title", lineHeight: 80, letterSpacing: 0 }, "TEXT")
  assert.equal(o.lineHeight, 80); assert.equal(o.letterSpacing, 0)
  // Stickies: size snaps to 16/24/40/64/96, no line height / spacing.
  o = await ctx.resolveTextOptions({ textStyle: "section" }, "STICKY")
  assert.equal(o.fontSize, 24); assert.equal(o.lineHeight, undefined); assert.equal(o.letterSpacing, undefined)
  assert.match(o.__ramp.substitutions.join(" "), /28px snapped to 24px/)
  o = await ctx.resolveTextOptions({ textStyle: "caption" }, "STICKY"); assert.equal(o.fontSize, 16)
  // Unknown role.
  await assert.rejects(ctx.resolveTextOptions({ textStyle: "jumbo" }, "TEXT"), /isn't a ramp role/)
  // Application to a text target.
  const t = fakeText("tags")
  o = await ctx.resolveTextOptions({ textStyle: "label", color: "#FF0000" }, "TEXT")
  await ctx.styleWhole(t, ctx.rampOpts(o))
  assert.deepEqual(JSON.parse(JSON.stringify(t.fontName)), { family: "Inter", style: "Bold" })
  assert.equal(t.fontSize, 12); assert.equal(t.lineHeight.value, 16); assert.equal(t.letterSpacing.value, 4); assert.equal(t.textCase, "UPPER")
  // Matching + nearest role.
  assert.equal(ctx.rampMatch(28, "Inter").role, "section")
  assert.equal(ctx.rampMatch(22, "Inter"), undefined)
  assert.equal(ctx.rampMatch(24, "Inter", true).role, "section")
  assert.equal(ctx.nearestRole(22, "Inter").role, "subhead")
  assert.equal(ctx.nearestRole(15, "Roboto Mono").role, "code-label")
  // type_ramp tool.
  let out = await call("type_ramp", {})
  assert.equal(out.result.roles.length, 13)
  const cap = out.result.roles.find(r => r.role === "caption")
  assert.equal(cap.fontSize, 13); assert.equal(cap.lineHeight, 20); assert.equal(cap.letterSpacing, 0.5)
  // review_layout: off-ramp text flagged low priority with nearest role.
  out = await call("review_layout", {})
  const off = out.result.issues.filter(i => i.type === "off-ramp-text")
  assert.deepEqual(off.map(i => i.ids[0]).sort(), ["1:2", "1:3"])
  assert.equal(off[0].priority, "low")
  assert.match(off.find(i => i.ids[0] === "1:2").fix, /textStyle subhead/)
  assert.match(off.find(i => i.ids[0] === "1:3").fix, /textStyle code-label/)
  console.log("all type-ramp checks passed")
})().catch(e => { console.error(e); process.exit(1) })
