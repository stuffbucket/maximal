// Runs the built panel (ui.html) with fake browser globals and checks that its
// Maximal and bridge connections, and the status text it shows, use the ports
// stamped by the build and agree with the manifest's devAllowedDomains.
//
// A bridge port of 0 is the normal case: Maximal hosts the bridge and the panel
// reaches it only through Maximal's origin (a discovery request, then the
// socket at ws://localhost:<maximalPort>/figjam/plugin), so the manifest allows
// nothing but Maximal. A bridge port above 0 is a standalone bridge, dialled
// directly and allowed in the manifest. Either way a keyed build must offer
// exactly its stamped relay key (the socket's subprotocol, and the discovery
// request's one header); an unkeyed one must open no socket, send no discovery
// request and say why. The key must never appear in anything the panel shows
// or logs.
//
//   node panel-ports.mjs <built dir> <maximalPort> <bridgePort> [saved baseUrl]
//
// PANEL_DISCOVERY picks what the fake Maximal answers to discovery: `ok`
// (default), `other-profile` (a different Maximal profile), `rejected` (403:
// the key isn't this Maximal's) or `down` (503, FigJam switched off).
import assert from "node:assert"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"

const [dir, maximalArg, bridgeArg, savedBase] = process.argv.slice(2)
const maximalPort = Number(maximalArg)
const bridgePort = Number(bridgeArg)
const html = fs.readFileSync(path.join(dir, "ui.html"), "utf8")
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"))

// The panel's one inline script, cut out of the ui.html this repo's build
// just wrote (a trusted fixture, not input to sanitize). No pattern matching:
// the panel must contain exactly one script element, opened as a bare
// `<script>` and closed by the last `</script>`, compared case-insensitively
// so an upper-case or second script tag fails this test instead of being
// skipped.
function panelScript(source) {
  const lower = source.toLowerCase()
  const opens = lower.split("<script").length - 1
  const closes = lower.split("</script").length - 1
  assert.equal(opens, 1, `ui.html must have exactly one script element, found ${opens}`)
  assert.equal(closes, 1, `ui.html must close its one script element, found ${closes}`)
  const open = lower.indexOf("<script>")
  assert.notEqual(open, -1, "the panel's script element must be a bare <script>")
  const start = open + "<script>".length
  const end = lower.indexOf("</script>", start)
  assert.ok(end > start, "the panel's script element must close with </script>")
  return source.slice(start, end)
}
const script = panelScript(html)
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
const discoveryRequests = []
const logged = []
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
const discovery = process.env.PANEL_DISCOVERY || "ok"
const profile = { kind: "development", id: stamped.profile || "ab12cd34ef56" }
const recordingConsole = new Proxy(console, {
  get: (target, key) => (...parts) => {
    if (typeof target[key] === "function") logged.push(parts.map(String).join(" "))
  },
})
const context = vm.createContext({
  window: win, parent: win.parent, document, console: recordingConsole, URL, URLSearchParams, JSON, Date, Math, Promise, Symbol,
  setTimeout, clearTimeout, setInterval, clearInterval,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  ResizeObserver: class { observe() {} disconnect() {} },
  IntersectionObserver: class { observe() {} disconnect() {} },
  AbortSignal: { timeout: () => undefined },
  navigator: { clipboard: {} },
  localStorage: { getItem: () => null, setItem() {} },
  WebSocket: FakeSocket,
  fetch: async (url, init) => {
    const text = String(url)
    if (new URL(text).pathname === "/figjam/bridge.json") {
      discoveryRequests.push({ url: text, headers: { ...(init?.headers ?? {}) } })
      if (discovery === "rejected") {
        return { ok: false, status: 403, json: async () => ({ error: { code: "RELAY_KEY_REJECTED" } }) }
      }
      const common = { service: "maximal-figjam-bridge", schema: 1, profile: discovery === "other-profile" ? { kind: "development", id: "0f0f0f0f0f0f" } : profile }
      if (discovery === "down") {
        return { ok: false, status: 503, json: async () => ({ ...common, available: false, reason: "disabled" }) }
      }
      return { ok: true, status: 200, json: async () => ({ ...common, available: true, panel: { path: "/figjam/plugin" } }) }
    }
    fetched.push(text)
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
await new Promise((resolve) => setTimeout(resolve, 100))

// The manifest allowlist and the panel agree: Maximal's origin (HTTP and
// WebSocket) and, only for a standalone bridge, that bridge's socket.
const allowed = manifest.networkAccess.devAllowedDomains
assert.deepEqual(
  allowed,
  bridgePort === 0
    ? [`http://localhost:${maximalPort}`, `ws://localhost:${maximalPort}`]
    : [`http://localhost:${maximalPort}`, `ws://localhost:${maximalPort}`, `ws://localhost:${bridgePort}`],
)

// Maximal: model calls go to the stamped port, and only to it.
assert.ok(fetched.length > 0, "the panel should have asked Maximal for its models")
for (const url of [...fetched, ...discoveryRequests.map((request) => request.url)]) {
  assert.ok(url.startsWith(`http://localhost:${maximalPort}/`), `unexpected Maximal URL ${url}`)
}
assert.equal(fetched[0], `http://localhost:${maximalPort}/v1/models`)

const status = () => elements.bridgeStatus.textContent

if (!relayKey) {
  // Without a key neither Maximal nor a bridge would accept it: nothing is asked.
  assert.equal(sockets.length, 0, "an unkeyed panel must not open the bridge socket")
  assert.equal(discoveryRequests.length, 0, "an unkeyed panel must not send a discovery request")
  assert.ok(status().startsWith("This copy of the plugin can't connect to the bridge."), status())
} else if (bridgePort > 0) {
  // A standalone bridge: dialled directly, on its stamped port, with the key.
  assert.equal(discoveryRequests.length, 0, "a standalone bridge needs no discovery")
  assert.equal(sockets.length, 1, "one bridge socket expected")
  assert.equal(sockets[0].url, `ws://localhost:${bridgePort}/plugin`)
  assert.ok(allowed.includes(new URL(sockets[0].url).origin.replace(/^http/, "ws")))
  assert.deepEqual(sockets[0].protocols, [relayKey])
  assert.equal(status(), `Connecting to the bridge on localhost:${bridgePort}…`)
} else if (discovery === "ok") {
  // Through Maximal: one discovery request carrying the key, then the socket on
  // Maximal's own origin (never a bridge port), offering the same key.
  assert.equal(discoveryRequests.length, 1)
  assert.equal(discoveryRequests[0].headers["x-maximal-figjam-relay-key"], relayKey)
  assert.ok(!discoveryRequests[0].url.includes(relayKey), "the key must not travel in the URL")
  assert.equal(sockets.length, 1, "one bridge socket expected")
  assert.equal(sockets[0].url, `ws://localhost:${maximalPort}/figjam/plugin`)
  assert.ok(allowed.includes(new URL(sockets[0].url).origin.replace(/^http/, "ws")))
  assert.deepEqual(sockets[0].protocols, [relayKey])
  assert.equal(status(), `Connecting to the bridge on localhost:${maximalPort}/figjam/plugin…`)

  // A refused connection says where it looked.
  sockets[0].onclose({ code: 1006 })
  assert.ok(
    status().startsWith(`The bridge isn't answering on localhost:${maximalPort}/figjam/plugin`),
    status(),
  )
} else {
  // Discovery said no (another profile, a key Maximal doesn't know, FigJam off):
  // the panel opens no socket, and says why.
  assert.equal(sockets.length, 0, `no socket expected after ${discovery}`)
  const said = status()
  if (discovery === "other-profile") assert.ok(said.includes("built for Maximal profile"), said)
  if (discovery === "rejected") assert.ok(said.includes("did not accept this plugin's key"), said)
  if (discovery === "down") assert.ok(said.includes("switched off"), said)
}

// The key appears only in the build line and the two places it is meant to go,
// never in what the panel shows or logs.
if (relayKey) {
  assert.ok(!status().includes(relayKey))
  assert.ok(!logged.join("\n").includes(relayKey), "the relay key must not be logged")
}

// Neither endpoint's text mentions a port the build didn't stamp.
const shown = [status(), elements.baseUrl.value].join(" ")
for (const port of [4141, 4150]) {
  if (port !== maximalPort && port !== bridgePort) assert.ok(!shown.includes(String(port)), shown)
}

// The panel's Maximal address defaults to the stamped port (an old saved default follows it).
assert.equal(elements.baseUrl.value, `http://localhost:${maximalPort}`)

// The static markup carries no port, so nothing wrong shows before the script runs.
assert.ok(!/localhost:\d+/.test(html.replace(script, "")), "ui.html markup must not hard-code a port")

console.log(`panel ports ${maximalPort}/${bridgePort} ${relayKey ? "keyed" : "unkeyed"} ${discovery} ok`)
process.exit(0)
