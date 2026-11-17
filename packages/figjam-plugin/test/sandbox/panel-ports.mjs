// Runs the built panel (ui.html) with fake browser globals and checks that its
// Maximal and bridge connections, and the status text it shows, use the ports
// stamped by the build and agree with the manifest's devAllowedDomains. A
// keyed build must offer exactly its stamped relay key as the socket's
// subprotocol; an unkeyed one must open no socket and say why.
//
//   node panel-ports.mjs <built dir> <maximalPort> <bridgePort> [saved baseUrl]
import assert from "node:assert"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"

const [dir, maximalArg, bridgeArg, savedBase] = process.argv.slice(2)
const maximalPort = Number(maximalArg)
const bridgePort = Number(bridgeArg)
const html = fs.readFileSync(path.join(dir, "ui.html"), "utf8")
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"))
const script = html.match(/<script>([\s\S]*)<\/script>/)[1]
const stamped = JSON.parse(html.match(/^const PANEL_BUILD = (.*);$/m)[1])
assert.equal(stamped.maximalPort, maximalPort)
assert.equal(stamped.bridgePort, bridgePort)
const relayKey = stamped.relayKey

// An element that accepts any call and keeps what's assigned to it.
const elements = {}
function element(id) {
  const store = { dataset: {}, style: {}, hidden: false, textContent: "", value: "" }
  const proxy = new Proxy(function () {}, {
    get(_t, key) {
      if (key in store) return store[key]
      if (key === "classList") return { add() {}, remove() {}, toggle() {}, contains: () => false }
      if (key === "matches" || key === "contains") return () => false
      if (key === "getBoundingClientRect") return () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 })
      return proxy
    },
    set(_t, key, value) { store[key] = value; return true },
    apply() { return proxy },
  })
  if (id) elements[id] = proxy
  return proxy
}
const document = {
  getElementById: (id) => elements[id] || element(id),
  createElement: () => element(),
  addEventListener() {},
  body: element(),
  documentElement: element(),
  activeElement: null,
  hidden: false,
}

const fetched = []
const sockets = []
class FakeSocket {
  static OPEN = 1
  readyState = 0
  constructor(url, protocols) { this.url = url; this.protocols = protocols; sockets.push(this) }
  send() {}
  close() {}
}

const posted = []
const win = {
  parent: { postMessage: (m) => posted.push(m) },
  addEventListener() {},
  onmessage: null,
}
win.top = win.parent
const models = { data: [{ id: "claude-sonnet-4", name: "Sonnet" }] }
const context = vm.createContext({
  window: win, parent: win.parent, document, console, URL, JSON, Date, Math, Promise, Symbol,
  setTimeout, clearTimeout, setInterval, clearInterval,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  ResizeObserver: class { observe() {} disconnect() {} },
  IntersectionObserver: class { observe() {} disconnect() {} },
  AbortSignal: { timeout: () => undefined },
  navigator: { clipboard: {} },
  localStorage: { getItem: () => null, setItem() {} },
  WebSocket: FakeSocket,
  fetch: async (url) => {
    fetched.push(String(url))
    return { ok: true, status: 200, json: async () => models }
  },
})
vm.runInContext(script, context)

const initMessage = {
  type: "init",
  settings: { remote: true, ...(savedBase ? { baseUrl: savedBase } : {}) },
  file: { name: "Board", boardId: "b1" },
  tools: [],
  plugin: {},
}
win.onmessage({ source: win.parent, data: { pluginMessage: initMessage } })
await new Promise((resolve) => setTimeout(resolve, 50))

// The manifest allowlist and the panel agree.
const allowed = manifest.networkAccess.devAllowedDomains
assert.deepEqual(allowed, [`http://localhost:${maximalPort}`, `ws://localhost:${bridgePort}`])

// Maximal: model calls go to the stamped port, and only to it.
assert.ok(fetched.length > 0, "the panel should have asked Maximal for its models")
for (const url of fetched) {
  assert.ok(url.startsWith(`http://localhost:${maximalPort}/`), `unexpected Maximal URL ${url}`)
}
assert.equal(fetched[0], `http://localhost:${maximalPort}/v1/models`)

const status = () => elements.bridgeStatus.textContent

if (relayKey) {
  // Bridge: the socket goes to the stamped port and offers the stamped key.
  assert.equal(sockets.length, 1, "one bridge socket expected")
  assert.equal(sockets[0].url, `ws://localhost:${bridgePort}/plugin`)
  assert.ok(allowed.includes(new URL(sockets[0].url).origin.replace(/^http/, "ws")))
  assert.deepEqual(sockets[0].protocols, [relayKey])

  // The connecting line names the stamped bridge port and no other.
  assert.equal(status(), `Connecting to the bridge on localhost:${bridgePort}…`)

  // A refused connection says where it looked.
  sockets[0].onclose({ code: 1006 })
  assert.equal(
    status().startsWith(`Can't reach the bridge on localhost:${bridgePort} `),
    true,
    status(),
  )
} else {
  // Without a key the bridge would refuse it, so no socket is opened.
  assert.equal(sockets.length, 0, "an unkeyed panel must not open the bridge socket")
  assert.ok(status().startsWith("This copy of the plugin can't connect to the bridge."), status())
}

// The key appears only in the build line, never in what the panel shows.
if (relayKey) assert.ok(!status().includes(relayKey))

// Neither endpoint's text mentions a port the build didn't stamp.
const shown = [status(), elements.baseUrl.value].join(" ")
for (const port of [4141, 4150]) {
  if (port !== maximalPort && port !== bridgePort) assert.ok(!shown.includes(String(port)), shown)
}
assert.equal(elements.baseUrl.value, `http://localhost:${maximalPort}`)

// The static markup carries no port, so nothing wrong shows before the script runs.
assert.ok(!/localhost:\d+/.test(html.replace(script, "")), "ui.html markup must not hard-code a port")

console.log(`panel ports ${maximalPort}/${bridgePort} ${relayKey ? "keyed" : "unkeyed"} ok`)
process.exit(0)
