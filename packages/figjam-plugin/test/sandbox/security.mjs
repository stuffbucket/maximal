// Stub checks for two trust boundaries:
// 1. run_code's `tools` go through runToolCall, so the confirm/expect guards,
//    page targeting and attribution apply to calls made from code too.
// 2. The panel relays bridge calls only as "agent:<name>", never "panel:".
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import assert from "node:assert"
const src = fs.readFileSync(process.argv[2], "utf8")
const ui = fs.readFileSync(path.join(path.dirname(process.argv[2]), "ui.html"), "utf8")
const posted = []
const byId = {}
function pd() { const d = {}; return { getPluginData: k => d[k] || "", setPluginData: (k, v) => { d[k] = v } } }
function walk(nodes, pred, out) { for (const n of nodes) { if (pred(n)) out.push(n); if (n.children) walk(n.children, pred, out) } return out }
function mk(o) {
  Object.assign(o, pd()); o.visible = true; o.locked = false
  if (o.children) { o.children.forEach(c => { c.parent = o; mk(c) }); o.findAll = pred => walk(o.children, pred || (() => true), []) }
  byId[o.id] = o; return o
}
function node(id, type, x, y, extra) {
  return Object.assign({ id, type, name: type, x, y, width: 240, height: 240, fills: [], absoluteBoundingBox: { x, y, width: 240, height: 240 }, absoluteTransform: [[1, 0, x], [0, 1, y]], remove() { this.removed = true } }, extra)
}
const sticky = node("1:1", "STICKY", 0, 0, { text: { characters: "keep me" } })
const p1 = mk({ id: "0:1", type: "PAGE", name: "Page 1", children: [sticky], selection: [], on() {}, off() {}, loadAsync: async () => {} })
const root = Object.assign({ name: "Untitled", children: [p1] }, pd())
const settings = { allowRunCode: true }
const figma = {
  mixed: Symbol("mixed"), root, currentPage: p1, fileKey: "FK1",
  clientStorage: { getAsync: async k => (k === "maximal-agent-settings" ? settings : undefined), setAsync: async () => {} },
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
const runCode = (code, actor) => call("run_code", { code, confirm: true }, actor)

;(async () => {
  // A delete from inside run_code needs its own confirm or expect, like any call.
  for (const actor of ["agent:a", "panel:test"]) {
    const out = await runCode('return await tools.delete_nodes({ ids: ["1:1"] })', actor)
    assert.equal(out.ok, false, `${actor}: delete from run_code should need confirm`)
    assert.match(String(out.error), /confirm_required|confirm/, out.error)
    assert.ok(!sticky.removed, `${actor}: the sticky must survive`)
  }

  // run_code and batch can't be reached from inside run_code.
  for (const inner of ["run_code", "batch"]) {
    const out = await runCode(`return await tools.${inner}({})`, "agent:a")
    assert.equal(out.ok, false)
    assert.match(String(out.error), /can't be called from run_code/)
  }

  // The tools object is a frozen copy: code can't swap in the raw functions.
  let out = await runCode("tools.delete_nodes = null; return typeof tools.delete_nodes", "agent:a")
  assert.equal(out.ok, true, out.error)
  assert.equal(out.result.result, "function")
  assert.equal(typeof ctx.tools.delete_nodes, "function", "the registry itself is untouched")

  // Reads still work through the guarded copy.
  out = await runCode("return await tools.list_pages({})", "agent:a")
  assert.equal(out.ok, true, out.error)

  // A write from run_code is attributed to run_code's actor.
  out = await runCode('return await tools.update_node({ id: "1:1", name: "renamed", confirm: true })', "agent:a")
  assert.equal(out.ok, true, out.error)
  assert.equal(ctx.recentWrites["1:1"].actor, "agent:a")

  // The panel stamps relayed calls "agent:<name>" whatever the bridge sends.
  assert.ok(ui.includes("relayedActor(msg.actor)"), "bridge tool calls must go through relayedActor")
  const fnText = ui.match(/function relayedActor\(actor\) \{[\s\S]*?\n\}/)
  assert.ok(fnText, "relayedActor not found in ui.html")
  const relayedActor = new Function(`return ${fnText[0]}`)()
  assert.equal(relayedActor("agent:capmap-b"), "agent:capmap-b")
  assert.equal(relayedActor("panel:grumpy-lynx"), "agent:panelgrumpy-lynx")
  assert.equal(relayedActor("agent:panel:x"), "agent:panelx")
  assert.equal(relayedActor(undefined), "agent:anonymous")
  assert.equal(relayedActor("agent:"), "agent:anonymous")
  assert.equal(relayedActor({ toString: () => "panel:x" }), "agent:anonymous")
  for (const a of ["panel:x", "agent:a b", "x".repeat(200)]) assert.ok(relayedActor(a).startsWith("agent:"))

  console.log("all security checks passed")
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
