// Stub checks for the comment tools (0.10.0): Figma REST calls with a personal
// access token kept in clientStorage. A fake fetch stands in for api.figma.com;
// the token must never appear in anything the sandbox posts or logs.
import fs from "node:fs"
import vm from "node:vm"
import assert from "node:assert"
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version
const src = fs.readFileSync(process.argv[2], "utf8")
const TOKEN = "fake-pat-for-tests-9876"
const posted = []
const logged = []
const byId = {}
function pd() { const d = {}; return { getPluginData: k => d[k] || "", setPluginData: (k, v) => { d[k] = v } } }
function walk(nodes, pred, out) { for (const n of nodes) { if (pred(n)) out.push(n); if (n.children) walk(n.children, pred, out) } return out }
function mk(o) { Object.assign(o, pd()); o.visible = true; o.locked = false; if (o.children) o.children.forEach(c => { c.parent = o; mk(c) }); byId[o.id] = o; return o }
function page(id, name, children) { const p = mk({ id, type: "PAGE", name, children, selection: [], on() {}, off() {}, loadAsync: async () => {} }); p.findAll = pred => walk(p.children, pred || (() => true), []); return p }
const sticky = { id: "6:8", type: "STICKY", name: "Idea sticky", x: 0, y: 0, width: 200, height: 200 }
const shape = { id: "7:1", type: "SHAPE_WITH_TEXT", name: "Other page shape", x: 0, y: 0, width: 100, height: 100 }
const p1 = page("0:1", "Page 1", [sticky])
const p2 = page("0:2", "Notes", [shape])
const root = Object.assign({ name: "Untitled", children: [p1, p2] }, pd())

const store = new Map()
const figma = {
  mixed: Symbol("mixed"), root, currentPage: p1, fileKey: "FK1",
  clientStorage: {
    getAsync: async k => store.get(k),
    setAsync: async (k, v) => { store.set(k, v) },
    deleteAsync: async k => { store.delete(k) },
  },
  showUI() {}, on() {}, notify() {}, commitUndo() {}, viewport: { center: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 1, height: 1 }, zoom: 1 },
  ui: { postMessage: m => posted.push(m), resize() {}, reposition() {} },
  getNodeByIdAsync: async id => byId[id] || null, setCurrentPageAsync: async p => { figma.currentPage = p },
}

// Fake fetch: answers from `replies` in order, records each request.
const requests = []
const replies = []
function reply(status, body, headersObject) {
  replies.push({ status, body: body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body), headersObject: headersObject || {} })
}
async function fakeFetch(url, init) {
  requests.push({ url, init })
  const r = replies.shift()
  if (!r) throw new Error("unexpected fetch " + url)
  if (r.throws) throw new Error(r.throws)
  return { status: r.status, ok: r.status >= 200 && r.status < 300, headersObject: r.headersObject, text: async () => r.body }
}

const capture = (...args) => logged.push(args.map(a => { try { return typeof a === "string" ? a : JSON.stringify(a) } catch { return String(a) } }).join(" "))
const fakeConsole = { log: capture, warn: capture, error: capture, info: capture, debug: capture }
const ctx = vm.createContext({ figma, __html__: "<html></html>", console: fakeConsole, fetch: fakeFetch, setTimeout, clearTimeout, Promise, Date, Math, JSON })
vm.runInContext(src, ctx)
let cid = 0
async function call(name, input) {
  const id = "c" + (cid++)
  await figma.ui.onmessage({ type: "tool", id, name, input, actor: "panel:test" })
  return posted.find(m => m.type === "tool-result" && m.id === id)
}
async function send(msg) {
  const before = posted.length
  await figma.ui.onmessage(msg)
  return posted.slice(before)
}

const user = handle => ({ id: "u-" + handle, handle, img_url: "https://example.invalid/" + handle + ".png" })
const COMMENTS = {
  comments: [
    { id: "101", file_key: "FK1", parent_id: "", user: user("ana"), created_at: "2026-11-01T10:00:00Z", resolved_at: null, message: "Pinned to the sticky", order_id: 1,
      client_meta: { node_id: "6:8", node_offset: { x: 10, y: 4 } },
      reactions: [{ user: user("bo"), emoji: ":+1:", created_at: "2026-11-01T10:05:00Z" }, { user: user("cy"), emoji: ":+1:", created_at: "2026-11-01T10:06:00Z" }, { user: user("bo"), emoji: ":eyes:", created_at: "2026-11-01T10:07:00Z" }] },
    { id: "103", file_key: "FK1", parent_id: "101", user: user("bo"), created_at: "2026-11-01T11:00:00Z", resolved_at: null, message: "Second reply", reactions: [] },
    { id: "102", file_key: "FK1", parent_id: "101", user: user("cy"), created_at: "2026-11-01T10:30:00Z", resolved_at: null, message: "First reply", reactions: [] },
    { id: "201", file_key: "FK1", parent_id: "", user: user("bo"), created_at: "2026-11-02T09:00:00Z", resolved_at: null, message: "Free-floating", order_id: 2, client_meta: { x: 100, y: 200 }, reactions: [] },
    { id: "301", file_key: "FK1", parent_id: "", user: user("cy"), created_at: "2026-11-03T09:00:00Z", resolved_at: "2026-11-04T09:00:00Z", message: "Done already", order_id: 3, client_meta: { node_id: "7:1", node_offset: { x: 0, y: 0 } }, reactions: [] },
    { id: "401", file_key: "FK1", parent_id: "", user: user("ana"), created_at: "2026-11-05T09:00:00Z", resolved_at: null, message: "On a deleted node", order_id: 4, client_meta: { node_id: "99:9", node_offset: { x: 0, y: 0 } }, reactions: [] },
  ],
}

;(async () => {
  assert.equal(ctx.PLUGIN_VERSION, PACKAGE_VERSION)
  for (const n of ["get_comments", "add_comment", "react_to_comment"]) {
    const spec = ctx.toolSpecs.find(s => s.name === n)
    assert.ok(spec, n + " is registered")
    assert.equal(spec.input_schema.properties.pageId, undefined, n + " has no page targeting")
  }
  assert.match(ctx.toolSpecs.find(s => s.name === "add_comment").description, /Only post when the user asked/)
  assert.ok(!ctx.toolSpecs.some(s => /^(delete|resolve)_comment/.test(s.name)))

  // init reports no token
  let out = await send({ type: "init" })
  const init = out.find(m => m.type === "init")
  assert.deepEqual(JSON.parse(JSON.stringify(init.figmaToken)), { hasToken: false, last4: "" })

  // no token: a clear error, no request
  let r = await call("get_comments", {})
  assert.equal(r.ok, false); assert.equal(r.code, "no_token")
  assert.match(r.error, /No Figma token: add one in the panel's Settings → Figma access token\./)
  r = await call("add_comment", { message: "hi" })
  assert.equal(r.code, "no_token")
  assert.equal(requests.length, 0)

  // save: the reply carries only hasToken + last4
  out = await send({ type: "figma-token-save", token: "  " + TOKEN + "\n" })
  assert.equal(out.length, 1)
  assert.deepEqual(Object.keys(out[0]).sort(), ["hasToken", "last4", "type"])
  assert.equal(out[0].hasToken, true); assert.equal(out[0].last4, "9876")
  assert.equal(store.get("maximal.figmaToken"), TOKEN)
  out = await send({ type: "figma-token-save", token: "has spaces in it" })
  assert.ok(out[0].error); assert.equal(out[0].hasToken, true); assert.equal(store.get("maximal.figmaToken"), TOKEN)

  // get_comments: threading, mapping, resolved hidden by default
  reply(200, COMMENTS)
  r = await call("get_comments", {})
  assert.ok(r.ok, r.error)
  const req = requests.pop()
  assert.equal(req.url, "https://api.figma.com/v1/files/FK1/comments")
  assert.equal(req.init.method, "GET"); assert.equal(req.init.headers["X-Figma-Token"], TOKEN)
  let res = r.result
  assert.equal(res.count, 3); assert.equal(res.resolvedHidden, 1)
  assert.deepEqual(res.threads.map(t => t.id), ["101", "201", "401"])
  const t1 = res.threads[0]
  assert.equal(t1.author, "ana"); assert.equal(t1.message, "Pinned to the sticky"); assert.equal(t1.createdAt, "2026-11-01T10:00:00Z"); assert.equal(t1.resolvedAt, null)
  assert.equal(t1.nodeId, "6:8"); assert.equal(t1.nodeName, "Idea sticky")
  assert.deepEqual(JSON.parse(JSON.stringify(t1.reactions)), [{ emoji: ":+1:", count: 2, by: ["bo", "cy"] }, { emoji: ":eyes:", count: 1, by: ["bo"] }])
  assert.deepEqual(t1.replies.map(x => [x.id, x.author, x.message]), [["102", "cy", "First reply"], ["103", "bo", "Second reply"]])
  assert.equal(res.threads[1].nodeId, null); assert.equal(res.threads[1].nodeName, null)
  assert.equal(res.threads[2].nodeId, "99:9"); assert.equal(res.threads[2].nodeName, null)
  assert.match(res.limits, /can't be resolved/)

  // includeResolved + markdown; node on another page still named
  reply(200, COMMENTS)
  r = await call("get_comments", { includeResolved: true, markdown: true })
  assert.equal(requests.pop().url, "https://api.figma.com/v1/files/FK1/comments?as_md=true")
  assert.equal(r.result.count, 4)
  const done = r.result.threads.find(t => t.id === "301")
  assert.equal(done.resolvedAt, "2026-11-04T09:00:00Z"); assert.equal(done.nodeName, "Other page shape")

  // nodeIds filter
  reply(200, COMMENTS)
  r = await call("get_comments", { nodeIds: ["6:8", "7:1"] })
  assert.deepEqual(r.result.threads.map(t => t.id), ["101"]); assert.equal(r.result.count, 1)
  reply(200, COMMENTS)
  r = await call("get_comments", { nodeIds: ["7:1"], includeResolved: true })
  assert.deepEqual(r.result.threads.map(t => t.id), ["301"])

  // none: count 0 and a note
  reply(200, { comments: [] })
  r = await call("get_comments", {})
  assert.equal(r.result.count, 0); assert.match(r.result.note, /No unresolved comments on this board/)

  // add_comment: plain
  reply(200, { id: "501", user: user("me"), created_at: "2026-11-10T09:00:00Z", message: "Plain", reactions: [] })
  r = await call("add_comment", { message: "Plain" })
  assert.ok(r.ok, r.error)
  let sent = requests.pop()
  assert.equal(sent.url, "https://api.figma.com/v1/files/FK1/comments"); assert.equal(sent.init.method, "POST")
  assert.equal(sent.init.headers["Content-Type"], "application/json")
  assert.deepEqual(JSON.parse(sent.init.body), { message: "Plain" })
  assert.equal(r.result.comment.id, "501"); assert.equal(r.result.nodeId, null)

  // add_comment: pinned to a node
  reply(200, { id: "502", user: user("me"), created_at: "2026-11-10T09:01:00Z", message: "Pinned", client_meta: { node_id: "6:8", node_offset: { x: 0, y: 0 } }, reactions: [] })
  r = await call("add_comment", { message: "Pinned", nodeId: "6:8" })
  assert.ok(r.ok, r.error)
  assert.deepEqual(JSON.parse(requests.pop().init.body), { message: "Pinned", client_meta: { node_id: "6:8", node_offset: { x: 0, y: 0 } } })
  assert.equal(r.result.nodeId, "6:8"); assert.equal(r.result.nodeName, "Idea sticky"); assert.equal(r.result.note, undefined)

  // add_comment: reply
  reply(200, { id: "503", parent_id: "101", user: user("me"), created_at: "2026-11-10T09:02:00Z", message: "A reply", reactions: [] })
  r = await call("add_comment", { message: "A reply", replyTo: "101" })
  assert.ok(r.ok, r.error)
  assert.deepEqual(JSON.parse(requests.pop().init.body), { message: "A reply", comment_id: "101" })
  assert.equal(r.result.replyTo, "101")

  // add_comment input checks (no request)
  const n = requests.length
  r = await call("add_comment", { message: "x", nodeId: "6:8", replyTo: "101" }); assert.equal(r.code, "bad_input")
  r = await call("add_comment", { message: "x", nodeId: "99:9" }); assert.equal(r.code, "not_found")
  r = await call("add_comment", { message: "   " }); assert.equal(r.code, "bad_input")
  assert.equal(requests.length, n)

  // pinned post rejected (e.g. FigJam): Figma's message plus a hint
  reply(400, { status: 400, err: "Invalid client_meta" })
  r = await call("add_comment", { message: "Pinned", nodeId: "6:8" })
  assert.equal(r.code, "bad_request"); assert.match(r.error, /Invalid client_meta/); assert.match(r.error, /retry without nodeId/)
  requests.pop()

  // react_to_comment
  reply(200, "")
  r = await call("react_to_comment", { commentId: "101", emoji: "heart" })
  assert.ok(r.ok, r.error)
  sent = requests.pop()
  assert.equal(sent.url, "https://api.figma.com/v1/files/FK1/comments/101/reactions")
  assert.deepEqual(JSON.parse(sent.init.body), { emoji: ":heart:" })

  // 403 (body echoing the token must be scrubbed), 404, 429 with Retry-After
  reply(403, { status: 403, err: "Invalid token " + TOKEN })
  r = await call("get_comments", {})
  assert.equal(r.code, "forbidden"); assert.match(r.error, /scope/); assert.match(r.error, /access to this file/)
  assert.ok(!r.error.includes(TOKEN))
  reply(404, { status: 404, err: "Not found" })
  r = await call("get_comments", {})
  assert.equal(r.code, "not_found"); assert.match(r.error, /file FK1/)
  reply(429, { status: 429, err: "Rate limit exceeded" }, { "Retry-After": "37" })
  r = await call("get_comments", {})
  assert.equal(r.code, "rate_limited"); assert.match(r.error, /retry after 37 seconds/)
  reply(429, "")
  r = await call("react_to_comment", { commentId: "101", emoji: ":+1:" })
  assert.match(r.error, /retry after a minute/)

  // network failure mentioning the token: scrubbed
  replies.push({ throws: "connection reset while sending X-Figma-Token: " + TOKEN })
  r = await call("get_comments", {})
  assert.equal(r.code, "network"); assert.match(r.error, /Couldn't reach Figma's API/); assert.ok(!r.error.includes(TOKEN))

  // file key falls back to the stored board URL, then a clear error
  figma.fileKey = undefined
  reply(200, { comments: [] })
  root.setPluginData("maximal.boardUrl", "https://www.figma.com/board/URLKEY9/Board")
  r = await call("get_comments", {})
  assert.ok(r.ok, r.error); assert.equal(requests.pop().url, "https://api.figma.com/v1/files/URLKEY9/comments")
  root.setPluginData("maximal.boardUrl", "")
  r = await call("get_comments", {})
  assert.equal(r.code, "no_file_key"); assert.match(r.error, /set_board_url/)
  figma.fileKey = "FK1"

  // clear
  out = await send({ type: "figma-token-clear" })
  assert.equal(out[0].hasToken, false); assert.equal(store.has("maximal.figmaToken"), false)
  r = await call("get_comments", {})
  assert.equal(r.code, "no_token")

  // the token never left the sandbox: not in anything posted to the panel, logged, or in the tool list
  const everything = JSON.stringify(posted) + JSON.stringify(logged) + JSON.stringify(ctx.toolSpecs)
  assert.ok(!everything.includes(TOKEN), "token leaked")
  assert.ok(!everything.includes(TOKEN.slice(0, -4)), "token prefix leaked")
  console.log("all comment checks passed")
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
